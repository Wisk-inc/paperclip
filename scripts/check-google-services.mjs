#!/usr/bin/env node
// Checks the Firebase config the Android app needs for "Continue with Google"
// and push notifications, and says exactly what is missing. Run:
//   node scripts/check-google-services.mjs [path/to/google-services.json]
// The default path is mobile/android/app/google-services.json (git-ignored).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const file = path.resolve(process.argv[2] ?? path.join(repoRoot, "mobile/android/app/google-services.json"));
const APP_ID = "com.corxlabs.automa";

function fail(lines) {
  console.error(`✗ ${path.relative(repoRoot, file)}`);
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

if (!existsSync(file)) {
  fail([
    "File not found. Download it from the Firebase console: Project settings → Your apps → the",
    `Android app with package ${APP_ID} → google-services.json, and save it at`,
    "mobile/android/app/google-services.json. Without it the app builds without sign-in.",
  ]);
}

let json;
try {
  json = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail([`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
}

const clients = Array.isArray(json.client) ? json.client : [];
const packages = clients.map((client) => client?.client_info?.android_client_info?.package_name).filter(Boolean);
const client = clients.find((entry) => entry?.client_info?.android_client_info?.package_name === APP_ID);
const problems = [];
if (!client) {
  problems.push(
    `No Android app for package ${APP_ID} in this file (it lists: ${packages.join(", ") || "none"}).`,
    "Gradle stops with “No matching client found for package name” when the package does not match.",
    `Fix: Firebase console → Project settings → Add app → Android → package name ${APP_ID}, then`,
    "download the new google-services.json.",
  );
}
const oauth = client?.oauth_client ?? [];
const webClient = oauth.find((entry) => entry?.client_type === 3);
if (client && !webClient) {
  problems.push(
    "No OAuth web client (client_type 3) for this app, so “Continue with Google” would stay off.",
    "Fix: Firebase console → Authentication → Sign-in method → Google → Enable, then",
    "Project settings → the Android app → add the SHA-1 fingerprints below, then download the file again.",
  );
}
const apiKey = client?.api_key?.[0]?.current_key;
if (client && !apiKey) problems.push("No API key for this app; download the file again from the console.");

console.log(`${problems.length ? "✗" : "✓"} ${path.relative(repoRoot, file)}`);
console.log(`  project: ${json.project_info?.project_id ?? "?"} (${json.project_info?.project_number ?? "?"})`);
console.log(`  apps: ${packages.join(", ") || "none"}`);
if (client) console.log(`  ${APP_ID}: OAuth web client ${webClient ? "present" : "missing"}, API key ${apiKey ? "present" : "missing"}`);
if (problems.length) {
  for (const line of problems) console.log(`  ${line}`);
  console.log("  SHA-1 fingerprints to register for the Android app in Firebase:");
  console.log("    release (the Play/APK signing key):  18:E2:32:34:67:3C:4E:58:AF:ED:56:4D:58:9A:2A:68:F8:99:FB:CA");
  console.log("    debug  (./gradlew assembleDebug):    run `keytool -list -v -keystore ~/.android/debug.keystore -storepass android` and copy SHA1");
  process.exit(1);
}
console.log("  Sign-in and push will be on in the next build.");
