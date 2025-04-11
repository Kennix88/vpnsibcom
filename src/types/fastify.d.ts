import '@fastify/request-context'
import 'fastify'

declare module 'fastify' {
  interface Session {
    userId?: string
    authenticated?: boolean
  }
}
