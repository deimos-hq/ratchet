// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The tests run inside workerd, the runtime the Worker is deployed on. They
// use test/wrangler.test.toml, not ../wrangler.toml: the real configuration
// declares container images, which need Docker to build, and nothing in these
// tests starts a container. test/harness.ts explains what stands in for one.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.test.toml' } })],
  test: { include: ['test/**/*.test.ts'] },
});
