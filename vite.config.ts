import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    format: "esm",
    dts: true,
    sourcemap: true,
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
