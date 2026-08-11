import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqlite-database";

describe("SqliteDatabase", () => {
  it("supports prepared statements, positional parameters, and iteration", () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");

    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    const first = insert.run("alpha");
    insert.run("beta");

    expect(first.changes).toBe(1);
    expect(first.lastInsertRowid).toBe(1);
    expect(db.prepare("SELECT name FROM items WHERE id = ?").get(2)).toEqual({ name: "beta" });
    expect(db.prepare("SELECT name FROM items ORDER BY id").all()).toEqual([
      { name: "alpha" },
      { name: "beta" },
    ]);
    expect([...db.prepare("SELECT name FROM items ORDER BY id").iterate()]).toEqual([
      { name: "alpha" },
      { name: "beta" },
    ]);

    db.close();
  });

  it("supports named parameters and PRAGMA statements", () => {
    const db = new SqliteDatabase(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE items (name TEXT NOT NULL)");
    db.prepare("INSERT INTO items (name) VALUES ($name)").run({ name: "alpha" });

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("SELECT name FROM items").get()).toEqual({ name: "alpha" });

    db.close();
  });

  it("normalizes booleans and undefined bindings to SQLite values", () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE items (enabled INTEGER NOT NULL, note TEXT)");
    db.prepare("INSERT INTO items (enabled, note) VALUES (?, ?)").run(true, undefined);
    db.prepare("INSERT INTO items (enabled, note) VALUES ($enabled, $note)").run({
      enabled: false,
      note: undefined,
    });

    expect(db.prepare("SELECT enabled, note FROM items ORDER BY rowid").all()).toEqual([
      { enabled: 1, note: null },
      { enabled: 0, note: null },
    ]);
    db.close();
  });

  it("commits successful transactions and rolls back failed transactions", () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE items (name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    const insertMany = db.transaction((names: string[]) => {
      for (const name of names) insert.run(name);
      return names.length;
    });

    expect(insertMany(["alpha", "beta"])).toBe(2);
    expect(() =>
      db.transaction(() => {
        insert.run("rolled-back");
        throw new Error("stop");
      })(),
    ).toThrow("stop");
    expect(db.prepare("SELECT name FROM items ORDER BY rowid").all()).toEqual([
      { name: "alpha" },
      { name: "beta" },
    ]);

    db.close();
  });

  it("uses savepoints for nested transactions without aborting the outer transaction", () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE items (name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    const inner = db.transaction(() => {
      insert.run("inner");
      throw new Error("inner failed");
    });
    const outer = db.transaction(() => {
      insert.run("outer-before");
      expect(inner).toThrow("inner failed");
      insert.run("outer-after");
    });

    outer();

    expect(db.prepare("SELECT name FROM items ORDER BY rowid").all()).toEqual([
      { name: "outer-before" },
      { name: "outer-after" },
    ]);
    db.close();
  });

  it("reopens an existing file-backed WAL database without losing data", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghcp-node-sqlite-"));
    const databasePath = path.join(fixtureDir, "existing.db");

    try {
      const original = new SqliteDatabase(databasePath);
      original.pragma("journal_mode = WAL");
      original.exec("CREATE TABLE existing_data (value TEXT NOT NULL)");
      original.prepare("INSERT INTO existing_data (value) VALUES (?)").run("preserved");
      original.close();

      const reopened = new SqliteDatabase(databasePath);
      expect(reopened.prepare("SELECT value FROM existing_data").get()).toEqual({ value: "preserved" });
      expect(reopened.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      reopened.close();
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});