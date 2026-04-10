/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  serverExternalPackages: ["better-sqlite3"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Prevent webpack from bundling better-sqlite3 (native module).
      // This avoids HMR crashes where .next/middleware-manifest.json
      // goes missing after a file change during dev.
      config.externals = [...(config.externals || []), "better-sqlite3"];
    }
    return config;
  },
};

export default nextConfig;
