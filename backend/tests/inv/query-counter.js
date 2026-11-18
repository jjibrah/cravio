// Query counter for the performance tests. Wraps a PGlite database so every query is counted and given a "level":
// the length of the longest chain of queries that had to wait for the one before (the critical path). With the real
// database every round trip costs ~250 ms, so depth x 250 ms is the latency floor of a request. Queries started
// together (Promise.all on the pool) share a level; a query started after another finished is one level deeper.
//
//   const counter = countQueries(db);          // counter.db is the wrapped database (pass it as `pool` and `transact`)
//   counter.reset(); await handler(...); const { total, depth } = counter.stats();
//
// The wrapper sets parallelSafe = true, which tells src/lib/pool.js canParallel() that concurrent queries are fine (as on a pool).
// Queries inside db.transaction() are counted too, but a transaction's client is NOT parallel safe (like pg's), and the
// wrapped transaction object says so, so code that would parallelise on a transaction client is caught by the depth number.
export function countQueries(db) {
  let total = 0;
  let done = 0; // the deepest level that has finished
  let maxLevel = 0;
  const log = [];

  const track = async (sql, run) => {
    const level = done + 1;
    total += 1;
    if (level > maxLevel) maxLevel = level;
    log.push({ level, sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 140) });
    try { return await run(); } finally { if (level > done) done = level; }
  };

  const wrap = (target, { parallelSafe }) => new Proxy(target, {
    get(obj, prop) {
      if (prop === 'parallelSafe') return parallelSafe;
      if (prop === 'query') return (sql, params) => track(typeof sql === 'string' ? sql : sql?.text, () => obj.query(sql, params));
      if (prop === 'exec') return (sql) => track(sql, () => obj.exec(sql));
      if (prop === 'transaction') return (fn) => obj.transaction((tx) => fn(wrap(tx, { parallelSafe: false })));
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });

  return {
    db: wrap(db, { parallelSafe: true }),
    reset() { total = 0; done = 0; maxLevel = 0; log.length = 0; },
    stats: () => ({ total, depth: maxLevel }),
    log: () => log.slice(),
  };
}
