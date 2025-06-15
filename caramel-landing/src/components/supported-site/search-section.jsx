"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import debounce from "lodash.debounce";
import SiteCard from "./site-card";
import SuggestionForm from "./suggestion-form";
import Loader from "@/components/Loader";
import {toast} from "react-toastify";
import {isValidUrl} from "@/lib/urlHelper";

export default function SearchSection() {
    const [query, setQuery] = useState("");
    const [sites, setSites] = useState([]);
    const [topSites, setTopSites] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);

    const loadTopSites = async () => {
        setLoading(true)
        setSearched(false);
        setSites([]);
        try {
            const res = await fetch("/api/sites/top-sites");
            const data = await res.json();
            setTopSites(data.sites || []);
        } catch (err) {
            toast.error("Failed to load top sites.");
            console.error("Failed to load top sites:", err);
        }
        setLoading(false);
    }
    useEffect(() => {
        loadTopSites();
    }, []);
    useEffect(() => {
        if(!query.trim()) {
            setSites([]);
            setSearched(false);
        } else {
            debouncedSearch(query);
        }
    }, [query]);

    const runSearch = async (q) => {
        setLoading(true);
        try {
            setSites([]);
            const res = await fetch("/api/sites/search-supported", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: q }),
            });
            const data = await res.json();
            setSites(data.sites || []);
        } catch (err) {
            console.log("Failed to search sites, Try again.");
            console.error(err);
        }
        setLoading(false);
        setSearched(true);
    }

    const debouncedSearch = useRef(debounce(runSearch, 400)).current;
    useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

    /* ui ------------------------------------------------------ */
    return (
        <section className="w-full max-w-3xl mx-auto px-4 sm:px-6">
            <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="text-center text-4xl md:text-3xl font-extrabold mb-10 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text text-transparent dark:from-orange-400 dark:to-caramel"
            >
                Is your favourite store supported?
            </motion.h1>

            <input
                type="url"
                inputMode="url"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="https://example.com"
                className="w-full rounded-full border-2 border-caramel/30 focus:border-caramel dark:focus:border-orange-400 px-6 py-4 text-lg sm:text-base shadow-md outline-none transition-all bg-white dark:bg-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
            />

            {/* loader */}
            <AnimatePresence>
                {loading && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex justify-center my-14"
                    >
                        <Loader />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* results / top sites / suggestion */}
            {!loading && (
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                    className="mt-12 space-y-6 mb-10"
                >
                    {sites.length ? (
                        <div className="grid pb-10 grid-cols-2 md:grid-cols-1 gap-6">
                            {sites.map((s, index) => (
                                <motion.div
                                    key={s}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{
                                        duration: 0.3,
                                        delay: 0
                                    }}
                                >
                                    <SiteCard site={s} />
                                </motion.div>
                            ))}
                        </div>
                    ) : (
                        <>
                        {searched && (<SuggestionForm resetValue={() => {
                            setQuery("");
                            setSites([]);
                            setSearched(false);
                        }} initialValue={query} />)} {
                            topSites.length > 0 &&  (
                                    <>
                                        <motion.h2
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ duration: 0.3 }}
                                            className="text-center border-b-[1px] mb-10 pb-10 text-2xl font-bold text-gray-800 dark:text-gray-200"
                                        >
                                            🏆 Top Supported Websites
                                        </motion.h2>
                                        <div className="grid pb-10 grid-cols-2 md:grid-cols-1 gap-6">
                                            {topSites.map((s, index) => (
                                                <motion.div
                                                    key={s}
                                                    initial={{ opacity: 0, y: 20 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    transition={{
                                                        duration: 0.3,
                                                        delay: 0
                                                    }}
                                                >
                                                    <SiteCard site={s} />
                                                </motion.div>
                                            ))}
                                        </div>
                                    </>
                        )}
                        </>
                    )}
                </motion.div>
            )}

        </section>
    );
}