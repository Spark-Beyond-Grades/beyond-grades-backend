const assert = require("assert");
const test = require("node:test");
const mongoose = require("mongoose");

const app = require("./app");

function requestHealth() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const body = await response.json();
        resolve({ status: response.status, body });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test("GET /health performs a deep MongoDB health check", async () => {
  const originalReadyState = mongoose.connection.readyState;
  const originalDb = mongoose.connection.db;
  let pingCalled = false;
  let queryCalled = false;

  try {
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      value: 1,
    });
    mongoose.connection.db = {
      admin() {
        return {
          async ping() {
            pingCalled = true;
            return { ok: 1 };
          },
        };
      },
      collection(name) {
        assert.strictEqual(name, "universities");
        return {
          async findOne(filter, options) {
            queryCalled = true;
            assert.deepStrictEqual(filter, {});
            assert.deepStrictEqual(options.projection, { _id: 1 });
            return null;
          },
        };
      },
    };

    const { status, body } = await requestHealth();

    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.database, true);
    assert.strictEqual(typeof body.latency, "number");
    assert.strictEqual(typeof body.uptime, "number");
    assert.strictEqual(typeof body.memory.rss, "number");
    assert.strictEqual(typeof body.memory.heapUsed, "number");
    assert.strictEqual(pingCalled, true);
    assert.strictEqual(queryCalled, true);
  } finally {
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      value: originalReadyState,
    });
    mongoose.connection.db = originalDb;
  }
});

test("GET /health returns 500 when MongoDB is disconnected", async () => {
  const originalReadyState = mongoose.connection.readyState;

  try {
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      value: 0,
    });

    const { status, body } = await requestHealth();

    assert.strictEqual(status, 500);
    assert.strictEqual(body.ok, false);
  } finally {
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      value: originalReadyState,
    });
  }
});

test("GET /health returns 500 when MongoDB ping fails", async () => {
  const originalReadyState = mongoose.connection.readyState;
  const originalDb = mongoose.connection.db;

  try {
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      value: 1,
    });
    mongoose.connection.db = {
      admin() {
        return {
          async ping() {
            throw new Error("ping failed");
          },
        };
      },
      collection() {
        throw new Error("query should not run after failed ping");
      },
    };

    const { status, body } = await requestHealth();

    assert.strictEqual(status, 500);
    assert.deepStrictEqual(body, { ok: false });
  } finally {
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      value: originalReadyState,
    });
    mongoose.connection.db = originalDb;
  }
});
