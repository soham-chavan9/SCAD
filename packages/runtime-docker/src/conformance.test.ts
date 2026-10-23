import { registerRuntimeConformance } from "@scad/runtime-conformance";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { ensureHttpEchoImage } from "./test-image.js";

registerRuntimeConformance("docker", async () => {
  const imageRef = await ensureHttpEchoImage();
  return {
    provider: new DockerRuntimeProvider(),
    imageRef,
    port: 8080,
  };
});
