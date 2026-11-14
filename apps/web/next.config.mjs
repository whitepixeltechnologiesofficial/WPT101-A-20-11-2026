import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo root (pnpm-lock.yaml lives there), stated rather than inferred.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),

  // packages/* ship TypeScript source (no build step), so Next compiles them.
  transpilePackages: ["@wpt/shared", "@wpt/api-client", "@wpt/crypto"],

  // The ONE switch between the WEB-R1.0 mock and the real backend (BE-6.1).
  // Inlined at build time so browser code can read process.env.API_BASE_URL.
  env: {
    API_BASE_URL: process.env.API_BASE_URL ?? "http://localhost:4010",
  },

  // Linting runs as its own task (`pnpm --filter web lint`, shared root
  // .eslintrc.cjs) rather than inside `next build`, which would otherwise
  // demand eslint-config-next, a second config the monorepo doesn't use.
  eslint: { ignoreDuringBuilds: true },

  webpack(config) {
    // The workspace packages use NodeNext-style `./x.js` specifiers that
    // point at `./x.ts` sources; teach webpack the same mapping tsc uses.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
