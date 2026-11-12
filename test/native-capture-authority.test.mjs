import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syntheticNativeCapture, nativeProfile } from "./helpers/native-portability-fixture.mjs";
import { prepareCodexNativeOffline } from "../scripts/lib/distribution/codex-native-offline.mjs";
import { captureCodexNativeHistory } from "../scripts/lib/distribution/codex-native-capture.mjs";
import { exportProjectBundle, inspectProjectBundle } from "../scripts/lib/storage/project-portability.mjs";
import { attachProjectNativeTransfer } from "../scripts/lib/session/project-native-transfer.mjs";

test("request revocation after observation or partial copy stops dependent capture/attachment without hiding its primary cause", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip("Measured native filesystem profile is Windows x64.");
  const { f, home, executable, destination } = await syntheticNativeCapture(t);
  for (const mode of ["after-observation", "before-publication", "after-raw", "signal"]) {
    let denied = false,
      armed = false;
    const controller = new AbortController();
    const offline = await prepareCodexNativeOffline({
      home,
      executable,
      probe: async () => {
        if (armed) {
          if (mode === "signal") controller.abort();
          else if (mode === "after-observation") denied = true;
        }
        return { status: "observed", rows: [] };
      },
      versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
    });
    armed = true;
    const target = path.join(f.base, "authority-" + mode);
    await assert.rejects(
      captureCodexNativeHistory({
        witness: offline.witness,
        threadIds: ["01900000-0000-7000-8000-000000000004"],
        destination: target,
        signal: controller.signal,
        assertCurrentAuthority() {
          if (denied)
            throw Object.assign(Error("Synthetic current request was revoked"), {
              code: "SYNTHETIC_CURRENT_REQUEST_REVOKED",
            });
        },
        onBoundary(boundary) {
          if (
            (mode === "before-publication" && boundary === "captured") ||
            (mode === "after-raw" && boundary === "raw-copied")
          )
            denied = true;
        },
      }),
      {
        code:
          mode === "signal"
            ? "NATIVE_CODEX_CAPTURE_CANCELLED"
            : "SYNTHETIC_CURRENT_REQUEST_REVOKED",
      },
    );
    assert(!fs.existsSync(path.join(target, "manifest.json")));
    if (mode !== "after-raw") assert(!fs.existsSync(target));
    else
      assert(
        fs.existsSync(path.join(target, "capture-intent.json")),
        "completed partial raw work remains identifiable, not replayed or erased",
      );
  }
  f.save({ summary: "Preserve the selected synthetic context" });
  const bundleRoot = path.join(f.base, "attachment-authority");
  f.route(() => exportProjectBundle({ root: f.root, destination: bundleRoot }));
  let denied = false;
  assert.throws(
    () =>
      attachProjectNativeTransfer({
        bundleRoot,
        directory: destination,
        onObject() {
          denied = true;
        },
        assertCurrentAuthority() {
          if (denied)
            throw Object.assign(Error("Synthetic attachment permission changed"), {
              code: "SYNTHETIC_ATTACHMENT_REVOKED",
            });
        },
      }),
    { code: "SYNTHETIC_ATTACHMENT_REVOKED" },
  );
  assert(!fs.existsSync(path.join(bundleRoot, "native-history.json")));
  assert.equal(inspectProjectBundle({ bundleRoot }).projectAdmissionReady, true);
});
