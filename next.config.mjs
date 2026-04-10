/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
