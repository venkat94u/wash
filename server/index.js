/**
 * MVP server: aggregates trades from exchanges, writes to SQLite, exposes cluster API.
 * NOTE: This is a minimal demonstration. For production you must add robust error handling,
 * rate-limit backoff, persistent job queues, authentication, and monitoring.
 */
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Database = require('better-sqlite3');
const pRetry = require('p-retry');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DB_FILE = path.join(__dirname, 'data.sqlite');
const db = new Database(DB_FILE);

// initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    exchange TEXT,
    symbol TEXT,
    price REAL,
    qty REAL,
    side TEXT,
    ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades(symbol, ts);
`);

// helpers
function insertTrade(trade){
  const stmt = db.prepare('INSERT OR IGNORE INTO trades (id, exchange, symbol, price, qty, side, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt.run(trade.id, trade.exchange, trade.symbol, trade.price, trade.qty, trade.side, trade.ts);
}

// Simple cluster aggregator: group trades into price buckets and sum qty, returns top clusters by volume
function computeClusters(symbol, exchange, periodMs=3600000, bucketSize=1.0, limit=100){
  // periodMs used for time-window grouping (not used in this simple aggregator except to filter time range)
  const since = Date.now() - periodMs;
  const rows = db.prepare('SELECT price, qty, ts FROM trades WHERE symbol = ? AND exchange = ? AND ts >= ?').all(symbol, exchange, since);
  if(!rows.length) return [];
  const buckets = new Map();
  for(const r of rows){
    // bucket by price step (bucketSize currency units)
    const pb = Math.round(r.price / bucketSize) * bucketSize;
    const key = pb.toFixed(8);
    const v = buckets.get(key) || {price: pb, volume:0, lastTs:0};
    v.volume += r.qty;
    v.lastTs = Math.max(v.lastTs, r.ts);
    buckets.set(key, v);
  }
  const arr = Array.from(buckets.values()).sort((a,b)=>b.volume - a.volume).slice(0,limit);
  return arr;
}

// Exchanges connectors (MVP)
async function fetchBinanceAggTrades(symbol, startTime, endTime, limit=1000){
  // symbol like BTCUSDT
  const url = `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

async function fetchOKXTrades(instId, limit=100){
  // instId example: BTC-USDT-SWAP
  const url = `https://www.okx.com/api/v5/market/trades?instId=${instId}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

async function fetchBybitTrades(symbol, limit=200){
  // symbol example: BTCUSDT
  const url = `https://api.bybit.com/public/linear/recent-trading-records?symbol=${symbol}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

// POST /api/backfill { symbol, exchange, startTs, endTs }
app.post('/api/backfill', async (req, res) => {
  const { symbol, exchange, startTs, endTs } = req.body;
  if(!symbol || !exchange) return res.status(400).json({error:'symbol, exchange required'});
  const start = Number(startTs) || (Date.now() - 24*3600*1000);
  const end = Number(endTs) || Date.now();
  try{
    if(exchange === 'binance'){
      // Binance supports large range via startTime & endTime; paginate by window if needed
      const windowMs = 60*60*1000; // fetch 1h windows
      for(let s = start; s < end; s += windowMs){
        const e = Math.min(end, s + windowMs - 1);
        console.log(`Fetching binance ${symbol} ${new Date(s).toISOString()} -> ${new Date(e).toISOString()}`);
        const data = await pRetry(()=> fetchBinanceAggTrades(symbol, s, e, 1000), {retries:3, minTimeout:500});
        if(Array.isArray(data) && data.length){
          for(const t of data){
            const trade = {
              id: `${symbol}-binance-${t.a||t.aggregateId||t.tradeId||Math.random()}`,
              exchange: 'binance',
              symbol: symbol,
              price: parseFloat(t.p),
              qty: parseFloat(t.q),
              side: (t.m === true) ? 'sell' : 'buy',
              ts: t.T || Date.now()
            };
            insertTrade(trade);
          }
        }
        // polite delay to avoid rate-limit
        await new Promise(r=>setTimeout(r,300));
      }
    } else if(exchange === 'okx'){
      // OKX recent trades endpoint is limited — do best-effort backfill by repeated calls near start
      // instId mapping: BTCUSDT -> BTC-USDT-SWAP (best-effort)
      const instId = symbol.replace(/USDT$/i,'-USDT-SWAP');
      const data = await pRetry(()=> fetchOKXTrades(instId, 100), {retries:2});
      if(data && data.data){
        for(const t of data.data){
          const trade = {
            id: `${symbol}-okx-${t.ts || t.tradeId || Math.random()}`,
            exchange: 'okx',
            symbol,
            price: parseFloat(t.p),
            qty: parseFloat(t.sz || t.qty || 0),
            side: (t.side === 'sell' || t.side === 'S') ? 'sell' : 'buy',
            ts: Number(t.ts) || Date.now()
          };
          insertTrade(trade);
        }
      }
    } else if(exchange === 'bybit'){
      const data = await pRetry(()=> fetchBybitTrades(symbol), {retries:2});
      if(data && data.result){
        for(const t of data.result){
          const trade = {
            id: `${symbol}-bybit-${t.trade_time_ms || Math.random()}`,
            exchange: 'bybit',
            symbol,
            price: parseFloat(t.price),
            qty: parseFloat(t.qty || t.size || 0),
            side: (t.side === 'Sell') ? 'sell' : 'buy',
            ts: t.trade_time_ms || Date.now()
          };
          insertTrade(trade);
        }
      }
    }
    return res.json({ok:true, message:'backfill done (best-effort, check DB)'});
  } catch(e){
    console.error('backfill error', e && e.message);
    return res.status(500).json({error: String(e)});
  }
});

app.get('/api/health', (req,res)=> res.json({ok:true, now: Date.now()}));

app.get('/api/top-clusters', (req,res)=>{
  const symbol = req.query.symbol || 'BTCUSDT';
  const exchange = req.query.exchange || 'binance';
  const limit = Number(req.query.limit) || 50;
  const periodMs = Number(req.query.periodMs) || (24*3600*1000); // last 24h by default
  const bucket = Number(req.query.bucket) || 1.0;
  const clusters = computeClusters(symbol, exchange, periodMs, bucket, limit);
  res.json({symbol, exchange, clusters});
});

// serve web UI static
app.use('/', express.static(path.join(__dirname, '../web')));

const port = process.env.PORT || 3000;
app.listen(port, ()=>{
  console.log('Server listening on', port);
});
