import Docker from "dockerode";

/** Start a temporary published-port container and wait for HTTP on the declared port. */
export async function smokeCheckHttp(opts: {
  docker?: Docker;
  imageRef: string;
  port: number;
  /** manifest.start as argv, same as the deploy (T1.5). Never a shell string. */
  start?: string[];
  /** manifest env, same as the deploy (T1.5). */
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  const docker = opts.docker ?? new Docker();
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const container = await docker.createContainer({
    Image: opts.imageRef,
    ...(opts.start !== undefined && opts.start.length > 0 ? { Entrypoint: opts.start, Cmd: [] } : {}),
    ...(opts.env ? { Env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) } : {}),
    ExposedPorts: { [`${opts.port}/tcp`]: {} },
    HostConfig: {
      PortBindings: {
        [`${opts.port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "0" }],
      },
      AutoRemove: true,
    },
  });

  try {
    await container.start();
    const info = await container.inspect();
    const binding = info.NetworkSettings.Ports?.[`${opts.port}/tcp`]?.[0];
    const hostPort = binding?.HostPort;
    if (!hostPort) {
      throw new Error("smoke check could not resolve published host port");
    }

    const url = `http://127.0.0.1:${hostPort}/`;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok || res.status < 500) {
          return;
        }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Object.assign(new Error("port did not become ready"), { cause: lastErr });
  } finally {
    await container.stop({ t: 1 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
  }
}
