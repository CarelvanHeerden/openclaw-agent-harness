/**
 * A real, local, authenticating Git HTTP server for tests.
 *
 * rc.10 / F1 needs to prove something about a partial clone that no mock can
 * prove: that `git bundle create` performs a NETWORK FETCH, that the fetch is
 * authenticated, and that the credential arrives through the child process
 * environment. A stubbed GitRunner would only re-assert the stub.
 *
 * So this serves a genuine repository over HTTP via `git http-backend` (the
 * same CGI git itself ships), requires HTTP Basic credentials, and enables
 * `uploadpack.allowfilter` so clients can clone `--filter=blob:none`. No
 * network egress, no personal token, no live GitHub.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { basename, dirname } from "node:path";

/**
 * @param {object} opts
 * @param {string} opts.repoPath  bare repo to serve
 * @param {string} opts.password  the only accepted password (the "token")
 * @param {string[]} [opts.log]   push each authenticated request path here
 */
export async function startGitHttpServer({ repoPath, password, log }) {
  let unauthorizedCount = 0;
  /** Every password the server was offered, to prove isolation between requesters. */
  const offered = [];

  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const supplied = auth.startsWith("Basic ")
      ? Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":")
      : null;
    if (supplied !== null) offered.push(supplied);

    if (supplied !== password) {
      unauthorizedCount++;
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="git"',
        "Content-Type": "text/plain",
      });
      // Mirror GitHub's wording so the test asserts against the shape the
      // incident actually produced.
      res.end("Invalid username or token. Password authentication is not supported for Git operations.");
      return;
    }

    log?.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        // http-backend resolves PATH_INFO UNDER the project root, and the URL
        // carries the repo name, so the root has to be the parent directory.
        GIT_PROJECT_ROOT: dirname(repoPath),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
      },
    });

    const chunks = [];
    cgi.stdout.on("data", (c) => chunks.push(c));
    cgi.on("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split === -1) {
        res.writeHead(500);
        res.end();
        return;
      }
      const headers = {};
      for (const line of raw.subarray(0, split).toString("utf8").split("\r\n")) {
        const at = line.indexOf(":");
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      const status = Number.parseInt(headers.Status ?? "200", 10) || 200;
      delete headers.Status;
      res.writeHead(status, headers);
      res.end(raw.subarray(split + 4));
    });
    req.pipe(cgi.stdin);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  return {
    /** Clone from here. Already includes the repository name. */
    url: `http://127.0.0.1:${port}/${basename(repoPath)}`,
    get unauthorizedCount() {
      return unauthorizedCount;
    },
    get passwordsOffered() {
      return [...offered];
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}
