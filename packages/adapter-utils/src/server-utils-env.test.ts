import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv, withoutServerCredentials } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("never hands an agent the server's database or session-signing credentials", () => {
    const env = sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://automa:db-password@127.0.0.1:5432/automa",
      DATABASE_MIGRATION_URL: "postgres://owner:owner-password@127.0.0.1:5432/automa",
      PGPASSWORD: "db-password",
      BETTER_AUTH_SECRET: "session-signing-secret",
      PAPERCLIP_LOCAL_TRUSTED_SECRET: "app-key",
      ANTHROPIC_API_KEY: "sk-ant-agent-key",
      GH_TOKEN: "gh-agent-token",
      PATH: "/usr/bin",
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-agent-key", GH_TOKEN: "gh-agent-token", PATH: "/usr/bin" });
    expect(JSON.stringify(env)).not.toContain("password");
  });
});

describe("withoutServerCredentials", () => {
  it("keeps the environment but drops the database, session signing and every Automa key or token", () => {
    expect(withoutServerCredentials({
      DATABASE_URL: "postgres://automa:db-password@127.0.0.1:5432/automa",
      PGPASSWORD: "db-password",
      BETTER_AUTH_SECRET: "session-signing-secret",
      PAPERCLIP_LOCAL_TRUSTED_SECRET: "app-key",
      PAPERCLIP_AGENT_JWT_SECRET: "jwt-secret",
      PAPERCLIP_SECRETS_MASTER_KEY: "master",
      PAPERCLIP_API_KEY: "run-token",
      PAPERCLIP_GITHUB_BROKER_TOKEN: "broker",
      PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "private",
      PAPERCLIP_HOME: "/data/automa",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      ANTHROPIC_API_KEY: "sk-ant-person-key",
      HOME: "/home/me",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_HOME: "/data/automa",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      ANTHROPIC_API_KEY: "sk-ant-person-key",
      HOME: "/home/me",
      PATH: "/usr/bin",
    });
  });
});
