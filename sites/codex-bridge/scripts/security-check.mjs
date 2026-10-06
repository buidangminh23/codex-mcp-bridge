import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const packageResolver = createRequire(import.meta.url);
const loaderResolver = createRequire(packageResolver.resolve("@esbuild-kit/core-utils"));
const esbuild = await import(pathToFileURL(loaderResolver.resolve("esbuild")).href);

test("SQLite identifiers preserve embedded quotes as identifier data", () => {
  const dialect = new SQLiteSyncDialect();
  for (const name of ["bridge_jobs", 'name"; DROP TABLE bridge_jobs; --', 'name" UNION SELECT token_hash FROM bridge_connector --']) {
    const query = dialect.sqlToQuery(sql`SELECT ${sql.identifier(name)}`);
    assert.equal(query.sql, `SELECT "${name.replaceAll('"', '""')}"`);
    assert.deepEqual(query.params, []);
  }
});

test("the migration loader retains synchronous and asynchronous TypeScript transforms", async () => {
  const source = 'import { value } from "./value.js"; export const result: number = value; export const location = import.meta.url;';
  const options = { loader: "ts", format: "esm", target: "node22" };
  const sync = esbuild.transformSync(source, options);
  const async = await esbuild.transform(source, options);
  assert.equal(sync.code, async.code);
  assert.match(sync.code, /import\.meta\.url/);
  assert.match(sync.code, /from "\.\/value\.js"/);
  assert.doesNotMatch(sync.code, /: number/);
});

test("the loader's esbuild server denies cross-origin source access", async () => {
  const context = await esbuild.context({ stdin: { contents: 'export const value = "local-source";', loader: "js" }, outfile: "security-check.js", write: false });
  try {
    const server = await context.serve({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${server.port}/security-check.js`;
    const legitimate = await fetch(url);
    assert.equal(legitimate.status, 200);
    assert.match(await legitimate.text(), /local-source/);
    for (const origin of ["https://attacker.invalid", "null"]) {
      const response = await fetch(url, { headers: { Origin: origin } });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      await response.arrayBuffer();
    }
  } finally {
    await context.dispose();
  }
});
