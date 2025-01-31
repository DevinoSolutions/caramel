import Link from "next/link";
import { motion } from "framer-motion";

export default function Signup() {
    return (
        <div className="flex h-screen items-center justify-center bg-gray-50">
            <motion.div
                className="w-full max-w-md bg-white shadow-lg rounded-lg p-8"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                <h2 className="text-2xl font-bold text-caramel text-center mb-6">
                    Create Your Account
                </h2>

                <form className="space-y-4">
                    <div>
                        <label className="block text-black text-sm font-medium">Full Name</label>
                        <input
                            type="text"
                            required
                            placeholder="Enter your full name"
                            className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-caramel"
                        />
                    </div>

                    <div>
                        <label className="block text-black text-sm font-medium">Email</label>
                        <input
                            type="email"
                            required
                            placeholder="Enter your email"
                            className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-caramel"
                        />
                    </div>

                    <div>
                        <label className="block text-black text-sm font-medium">Password</label>
                        <input
                            type="password"
                            required
                            placeholder="Create a password"
                            className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-caramel"
                        />
                    </div>

                    <button
                        type="submit"
                        className="w-full bg-caramel text-white font-semibold py-2 rounded-md hover:scale-105 transition"
                    >
                        Sign Up
                    </button>
                </form>

                <p className="text-sm text-gray-600 text-center mt-4">
                    Already have an account?{" "}
                    <Link href="/login" className="text-caramel font-semibold">
                        Login
                    </Link>
                </p>
            </motion.div>
        </div>
    );
}
