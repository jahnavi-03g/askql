/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // optimised for Lambda/container deploys
};

module.exports = nextConfig;
