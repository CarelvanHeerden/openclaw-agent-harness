/**
 * Replays a REAL captured OpenCode session as an ACP agent.
 *
 * Every other ACP test in this suite drives `tests/fixtures/fake-acp-agent.mjs`,
 * which does exactly what we expect an agent to do — which is the problem. It
 * is a fixture written from the same understanding as the adapter, so the two
 * agree by construction and a shared misreading of the protocol survives every
 * test.
 *
 * This one replays `probe/runs/*.jsonl`: actual wire transcripts captured from
 * OpenCode 1.18.11 by `probe/acp-probe.mjs`. It cannot flatter the adapter,
 * because it was recorded before the adapter existed. It is what caught the
 * `fs/write_text_file` case — OpenCode asks permission for an edit and then
 * asks the CLIENT to perform the write, despite `initialize` declaring
 * `fs: {writeTextFile: false}`.
 *
 * HOW IT REPLAYS. The capture is a sequence of framed messages tagged `in`
 * (agent to client) and `out` (client to agent). Replaying strictly by
 * timestamp would be flaky, so instead:
 *
 *  - for each client REQUEST, everything the agent sent BEFORE its response —
 *    permission requests, session updates, the delegated write — is replayed
 *    first, in captured order, and
 *  - the captured response is then sent, with the id rewritten to the live one.
 *
 * That ordering is the whole point. The permission requests arrive *during*
 * `session/prompt`, not after it: answering the prompt first would end the turn
 * before the guard was ever consulted, which is precisely the bug an
 * order-insensitive replay would hide.
 *
 * So the adapter sees the real frames, in the real order, and its own ids and
 * timing stay its own. Usage: `node acp-replay-agent.mjs <capture.jsonl>`.
 */

import { readFileSync, writeFileSync } from "node:fs";

const capturePath = process.argv[2];

/**
 * Where to record what the CLIENT answered to the agent's own requests.
 *
 * Without this the replay can only assert that a turn completed, which is
 * exactly what a silently-wrong answer also does. The refusal of a declined fs
 * capability is only observable from the agent's side, so the agent has to be
 * the one to report it.
 */
const reportPath = process.env.ACP_REPLAY_REPORT;
const observed = [];

function writeReport() {
  if (!reportPath) return;
  try { writeFileSync(reportPath, JSON.stringify(observed)); } catch { /* best effort */ }
}
if (!capturePath) {
  process.stderr.write("acp-replay-agent: no capture path given\n");
  process.exit(2);
}

const frames = readFileSync(capturePath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/** Captured client→agent requests, in order, so we can match by method. */
const clientRequests = frames
  .filter((f) => f.dir === "out" && f.payload?.method !== undefined && f.payload?.id !== undefined)
  .map((f) => ({ method: f.payload.method, id: f.payload.id }));

/** Captured agent→client frames, keyed by the captured request id they answer. */
function capturedResponseFor(capturedId) {
  return frames.find((f) => f.dir === "in" && f.payload?.id === capturedId && f.payload?.method === undefined)?.payload;
}

function frameIndexOfClientRequest(capturedId) {
  return frames.findIndex((f) => f.dir === "out" && f.payload?.id === capturedId);
}

function frameIndexOfResponse(capturedId) {
  return frames.findIndex(
    (f) => f.dir === "in" && f.payload?.id === capturedId && f.payload?.method === undefined,
  );
}

/**
 * Agent-initiated traffic sent while a client request was outstanding.
 *
 * This is what the adapter has to cope with mid-turn: `session/update` chunks,
 * `session/request_permission` round-trips, and the `fs/write_text_file` that
 * OpenCode sends despite our declining the capability.
 */
function agentTrafficDuring(requestIndex, responseIndex) {
  const end = responseIndex === -1 ? frames.length : responseIndex;
  return frames
    .slice(requestIndex + 1, end)
    .filter((f) => f.dir === "in" && f.payload?.method !== undefined)
    .map((f) => f.payload);
}

/**
 * Captured requests already consumed, so a method sent twice gets the second
 * captured occurrence rather than repeating the first.
 */
const consumed = new Set();

/**
 * Match the adapter's request to a captured one BY METHOD, not by position.
 *
 * Position matching seems reasonable and is wrong: the capture includes an
 * `authenticate` call that the adapter does not make, so every subsequent
 * request lines up against the previous one's response. The visible symptom is
 * subtle — the turn still completes, because the responses are all
 * well-formed — but `session/prompt` gets `session/new`'s answer and the
 * permission requests attached to the real prompt are never replayed. A guard
 * test would pass while asserting nothing.
 */
function takeCapturedRequest(method) {
  const i = clientRequests.findIndex((r, idx) => r.method === method && !consumed.has(idx));
  if (i === -1) return undefined;
  consumed.add(i);
  return clientRequests[i];
}

let buf = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Ids the agent uses for its own requests must not collide with the client's. */
let agentRequestId = 10_000;
/** Live id -> { method, resolve }, so a response can be awaited and attributed. */
const agentRequestMethods = new Map();

/**
 * Ask the client something and WAIT for the answer.
 *
 * Waiting is not incidental. A real agent blocks on the result of a delegated
 * write before it finishes its turn; replaying fire-and-forget instead lets the
 * captured `session/prompt` response close the turn first, after which the
 * adapter tears the child down and the answer is never observed. That produced
 * a test that failed for a reason having nothing to do with the adapter.
 */
function ask(method, params) {
  const id = agentRequestId++;
  return new Promise((resolve) => {
    agentRequestMethods.set(id, { method, resolve });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** Serialises the handler, so replay ordering survives an await. */
let chain = Promise.resolve();

process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;

    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // Responses are handled INLINE, never through `chain`. A request handler
    // that is awaiting `ask()` holds the chain, so queueing the very response
    // it is waiting for behind that handler deadlocks the agent against
    // itself — which presents as a wedged turn and a 25-second timeout with no
    // hint that the fixture, not the adapter, is at fault.
    if (msg.method === undefined) {
      const pending = agentRequestMethods.get(msg.id);
      if (pending) {
        agentRequestMethods.delete(msg.id);
        observed.push({
          method: pending.method,
          ok: msg.error === undefined,
          errorCode: msg.error?.code,
          errorMessage: msg.error?.message,
        });
        writeReport();
        pending.resolve();
      }
      continue;
    }

    chain = chain.then(() => handle(msg));
  }
});

async function handle(msg) {
    const captured = takeCapturedRequest(msg.method);
    if (!captured) {
      // The adapter asked for something the capture never contained. Answer
      // with an empty result rather than hanging, so the test fails on an
      // assertion rather than a timeout.
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    // Everything the agent sent WHILE this request was outstanding, first.
    // Answering the request before replaying these would end the turn before
    // the guard was ever consulted.
    const here = frameIndexOfClientRequest(captured.id);
    const responseAt = frameIndexOfResponse(captured.id);

    for (const payload of agentTrafficDuring(here, responseAt)) {
      if (payload.id !== undefined) {
        // Await it, like a real agent would. See `ask`.
        await ask(payload.method, payload.params);
      } else {
        send({ jsonrpc: "2.0", method: payload.method, params: payload.params });
      }
    }

    // ...and only then the response that closes it.
    const response = capturedResponseFor(captured.id);
    if (msg.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        ...(response?.error ? { error: response.error } : { result: response?.result ?? {} }),
      });
    }
}

process.stdin.on("end", () => { writeReport(); process.exit(0); });
process.on("exit", writeReport);
