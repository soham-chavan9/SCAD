import { describe, expect, it } from "vitest";
import { buildArgs, buildEnv, dockerBuild } from "./docker-build.js";

describe("dockerBuild isolation (INV8)", () => {
  it("always runs docker build with --network=none and no build args", () => {
    const args = buildArgs({ contextDir: "/ctx", imageRef: "scad-apps/x:v1" });
    expect(args).toContain("--network=none");
    expect(args.some((a) => a.startsWith("--build-arg"))).toBe(false);
    expect(args.some((a) => a.startsWith("--secret"))).toBe(false);
    expect(args.some((a) => a.startsWith("--ssh"))).toBe(false);
    expect(args.at(-1)).toBe("/ctx");
  });

  it("passes only Docker client variables to the docker CLI, never platform secrets", () => {
    const env = buildEnv({
      PATH: "/usr/bin",
      HOME: "/home/b",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      MASTER_KEY: "secret",
      JWT_PRIVATE_KEY: "secret",
      GITHUB_CLIENT_SECRET: "secret",
      INTERNAL_SECRET: "secret",
      INTERNAL_TOKEN: "secret",
      DATABASE_URL: "postgres://secret",
      SMTP_URL: "smtp://secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/b",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
  });

  it("invokes the exec function with the isolated argv and scrubbed env", async () => {
    const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const result = await dockerBuild({
      contextDir: "/ctx",
      imageRef: "img:v1",
      parentEnv: { PATH: "/bin", MASTER_KEY: "k" },
      exec: async (file, args, options) => {
        calls.push({ file, args, env: options.env });
        return { stdout: "ok", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("docker");
    expect(calls[0]?.args).toContain("--network=none");
    expect(calls[0]?.env).toEqual({ PATH: "/bin" });
  });
});

describe("scrubPlatformSecrets (INV8)", () => {
  it("removes platform secrets from the builder's own environment", async () => {
    const { scrubPlatformSecrets } = await import("./docker-build.js");
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin",
      MASTER_KEY: "k",
      JWT_PRIVATE_KEY: "k",
      GITHUB_CLIENT_SECRET: "k",
      INTERNAL_SECRET: "k",
      INTERNAL_TOKEN: "k",
      DATABASE_URL: "k",
      SMTP_URL: "k",
    };
    scrubPlatformSecrets(env);
    expect(env).toEqual({ PATH: "/bin" });
  });
});
