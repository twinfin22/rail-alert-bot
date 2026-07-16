import { Database } from "bun:sqlite";

type Params = (string | number | null)[];

class FakeStatement {
  constructor(private db: Database, private sql: string, private params: Params = []) {}

  bind(...params: Params): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number | bigint } }> {
    const result = this.db.query(this.sql).run(...this.params);
    return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
  }

  async first<T>(): Promise<T | null> {
    return this.db.query(this.sql).get(...this.params) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...this.params) as T[] };
  }
}

export class FakeD1 {
  readonly db = new Database(":memory:");

  async migrate(): Promise<void> {
    for (const file of ["migrations/0001_initial.sql", "migrations/0002_poll_metrics.sql", "migrations/0003_poll_control_plane.sql"]) {
      this.db.exec(await Bun.file(file).text());
    }
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

export async function createFakeD1(): Promise<FakeD1> {
  const d1 = new FakeD1();
  await d1.migrate();
  return d1;
}
