import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const authMode = process.env.DASHBOARD_AUTH_MODE || 'none';
  const pathname = request.nextUrl.pathname;
  
  if (authMode === 'none') {
    return NextResponse.next();
  }

  const isProtectedRoute = pathname.startsWith('/api/') || pathname.startsWith('/dashboard/');
  
  if (isProtectedRoute) {
    if (authMode === 'api-key') {
      const apiKey = process.env.DASHBOARD_API_KEY;
      if (!apiKey) {
        console.error("DASHBOARD_AUTH_MODE is 'api-key' but DASHBOARD_API_KEY is not set.");
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }

      const authHeader = request.headers.get('Authorization');
      const xApiKey = request.headers.get('x-api-key');
      
      let providedKey: string | null = null;
      
      if (authHeader?.startsWith('Bearer ')) {
        providedKey = authHeader.slice(7);
      } else if (xApiKey) {
        providedKey = xApiKey;
      }
      
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
      
      try {
        const credentials = atob(authHeader.slice(6));
        if (credentials !== basicAuth) {
          return new NextResponse('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' },
          });
        }
      } catch {
        return new NextResponse('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' },
        });
      }
    } else {
      console.error(`DASHBOARD_AUTH_MODE has unknown value: '${authMode}'. Failing closed for security.`);
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/:path*',
    '/dashboard/:path*',
  ],
};
