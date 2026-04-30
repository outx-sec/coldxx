import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { main } from "../src/cli.js";

test("main prints package version with -v and --version", async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

  const shortOutput = await runCli(["-v"]);
  assert.equal(shortOutput.code, 0);
  assert.equal(shortOutput.stdout, `coldxx ${packageJson.version}\n`);

  const longOutput = await runCli(["--version"]);
  assert.equal(longOutput.code, 0);
  assert.equal(longOutput.stdout, `coldxx ${packageJson.version}\n`);
});

test("help documents version option", async () => {
  const output = await runCli(["--help"]);

  assert.equal(output.code, 0);
  assert.match(output.stdout, /--version, -v\s+print version/);
});

async function runCli(argv) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
  });

  return { code, stdout, stderr };
}
