// The application's own middleware, wrapped: it stamps a header so the e2e
// can prove it still runs for everyone NORG does not answer.
import { NextResponse } from 'next/server'
import { withNorgEdge } from '@norg-ai/edge-router-vercel/next'

function appMiddleware() {
  const response = NextResponse.next()
  response.headers.set('x-app-middleware', '1')
  return response
}

export default withNorgEdge(appMiddleware)

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
}
