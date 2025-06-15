"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {toast} from "react-toastify";
import {isValidUrl} from "@/lib/urlHelper";

export default function SuggestionForm({ initialValue, resetValue }) {
    const [url, setUrl] = useState(initialValue);
    const [loading, setLoading] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        if (!url.trim()) return;
        if(!isValidUrl(url)) {
            toast.warn("Please enter a valid URL.");
            return;
        }
        setLoading(true);
        try {
            await fetch("/api/sites/suggest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
            });
            toast.success(`Thanks! We’ll look into supporting ${url} soon`)
        } catch (err) {
            toast.error("Failed to send suggestion. Please try again later.");
            console.error(err);
        }
        resetValue();
        setLoading(false);
    };

    return (
        <form
            onSubmit={submit}
            className="flex flex-col items-center gap-6 bg-gradient-to-br from-caramel/5 via-orange-50/20 to-caramel/5 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10 border border-caramel/20 dark:border-caramel/30 rounded-3xl p-8 sm:p-6 shadow-md w-full"
        >
            <p className="text-gray-700 dark:text-gray-300 text-center leading-relaxed">
                We don’t support that store yet. Let us know and we’ll add it!
            </p>
            <motion.button
                whileTap={{ scale: 0.95 }}
                className="px-8 py-3 rounded-full bg-gradient-to-r from-caramel to-orange-600 text-white font-semibold shadow hover:shadow-lg transition-all"
            >
                {loading ? "Sending…" : (
                    <>
                        Request Support for <span className="font-bold">{url}</span>
                    </>
                    )}
            </motion.button>
        </form>
    );
}
