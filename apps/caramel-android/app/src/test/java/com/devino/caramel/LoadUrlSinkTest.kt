package com.devino.caramel

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Lint-style check: the WebView is only ever loaded through `WebView.loadGuarded` (web/ShellWebView.kt),
 * which re-checks AppLinkGuard at the sink. A raw `.loadUrl(` anywhere else would be a way around it.
 * Gradle runs unit tests with the module directory (app/) as the working directory.
 */
class LoadUrlSinkTest {
    private val sourceRoot = File("src/main/java")
    private val rawLoaders = listOf("loadUrl(", "loadData(", "loadDataWithBaseURL(", "postUrl(")

    private fun codeLines(file: File): List<Pair<Int, String>> = file.readLines().withIndex()
        .map { (index, line) -> index + 1 to line.trim() }
        .filter { (_, line) -> !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*") }

    private fun kotlinSources(): List<File> {
        assertTrue("source root not found from ${File(".").absoluteFile}", sourceRoot.isDirectory)
        return sourceRoot.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    @Test
    fun rawLoadersAppearNowhereOutsideTheGuardedSink() {
        val offenders = kotlinSources()
            .filter { it.name != "ShellWebView.kt" }
            .flatMap { file -> codeLines(file).filter { (_, line) -> rawLoaders.any { it in line } }.map { (n, line) -> "${file.name}:$n $line" } }
        assertEquals("raw WebView loaders outside loadGuarded: $offenders", emptyList<String>(), offenders)
    }

    @Test
    fun theSinkFileCallsLoadUrlExactlyOnceInsideLoadGuarded() {
        val sink = kotlinSources().single { it.name == "ShellWebView.kt" }
        val calls = codeLines(sink).filter { (_, line) -> rawLoaders.any { it in line } }
        assertEquals(calls.toString(), 1, calls.size)
        val text = sink.readText()
        val body = text.substringAfter("fun WebView.loadGuarded(").substringBefore("\n}\n")
        assertTrue("loadUrl is not inside loadGuarded", "loadUrl(" in body)
        assertTrue("loadGuarded does not re-check the guard", "AppLinkGuard.allowedTarget(url)" in body)
    }
}
