import { authOptions } from '@/lib/authOptions'
import NextAuth from 'next-auth'

export const { GET: auth, POST } = NextAuth(authOptions)
