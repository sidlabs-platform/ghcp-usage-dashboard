import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const authMode = process.env.DASHBOARD_AUTH_MODE || 'none';
  
  if (authMode === 'none') {
    return NextResponse.next();
  }

  // Protect /api/* routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    if (authMode === 'api-key') {
      const apiKey = process.env.DASHBOARD_API_KEY;
      if (!apiKey) {
          console.error("DASHBOARD_AUTH_MODE is 'api-key' but DASHBOARD_API_KEY is not set.");
          return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }

      const authHeader = request.headers.get('Authorization');
      const providedKey = authHeader?.replace('Bearer ', '');
      
      if (providedKey !== apiKey) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else if (authMode === 'basic') {
        const basicAuth = process.env.DASHBOARD_BASIC_AUTH;
        if (!basicAuth) {
            console.error("DASHBOARD_AUTH_MODE is 'basic' but DASHBOARD_BASIC_AUTH is not set (expected user:pass).");
            return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
        }
        
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Basic ')) {
             return new NextResponse('Authentication required', {
                status: 401,
                headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' },
              });
        }
        
        const credentials = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('ascii');
        if (credentials !== basicAuth) {
             return new NextResponse('Unauthorized', {
                status: 401,
                headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' },
              });
        }
    }
  }

  // Future PR: Add OAuth or cookie checks for /dashboard UI routes here if needed
  
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Apply to all API routes
    '/api/:path*',
  ],
};
