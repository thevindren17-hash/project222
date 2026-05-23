import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: [
    '@fullcalendar/core',
    '@fullcalendar/react',
    '@fullcalendar/daygrid',
    '@fullcalendar/timegrid',
    '@fullcalendar/interaction',
  ],
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options',    value: 'nosniff' },
        { key: 'X-Frame-Options',            value: 'DENY' },
        { key: 'X-XSS-Protection',           value: '1; mode=block' },
        { key: 'Referrer-Policy',            value: 'strict-origin-when-cross-origin' },
        // Allow microphone for voice calls from same origin only
        { key: 'Permissions-Policy',         value: 'camera=(), microphone=(self)' },
        { key: 'Strict-Transport-Security',  value: 'max-age=63072000; includeSubDomains; preload' },
      ],
    },
  ],
}

export default nextConfig
