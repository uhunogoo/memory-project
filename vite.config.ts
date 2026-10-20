import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    format: "esm",
    dts: true,
    sourcemap: true,
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
