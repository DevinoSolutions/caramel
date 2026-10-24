package com.devino.caramel

import com.devino.caramel.core.DiscountFormat
import com.devino.caramel.core.Timestamps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.util.Locale

class ModelsTest {
    @Test
    fun percentageAndAmountLabels() {
        assertEquals("20% off", DiscountFormat.label("PERCENTAGE", 20.0))
        assertEquals("\$5 off", DiscountFormat.label("FIXED", 5.0))
        assertEquals("\$7.50 off", DiscountFormat.label("FIXED", 7.5))
        assertNull(DiscountFormat.label("PERCENTAGE", 0.0))
        assertNull(DiscountFormat.label(null, null))
    }

    @Test
    fun moneyFormatsMinorUnitsAndFallsBackOnUnknownCurrency() {
        assertEquals("\$12.34", DiscountFormat.money(1234, "USD", Locale.US))
        assertEquals("1234 ZZZZ", DiscountFormat.money(1234, "ZZZZ", Locale.US))
    }

    @Test
    fun parsesFractionalAndPlainTimestamps() {
        assertNotNull(Timestamps.parse("2026-10-23T10:00:00.123Z"))
        assertNotNull(Timestamps.parse("2026-10-23T10:00:00Z"))
        assertNull(Timestamps.parse("yesterday"))
    }

    @Test
    fun relativeTimestamps() {
        val now = Instant.parse("2026-10-23T12:00:00Z")
        assertEquals("just now", Timestamps.relative("2026-10-23T11:59:30Z", now))
        assertEquals("1 minute ago", Timestamps.relative("2026-10-23T11:59:00Z", now))
        assertEquals("3 hours ago", Timestamps.relative("2026-10-23T09:00:00.000Z", now))
        assertEquals("2 days ago", Timestamps.relative("2026-10-21T12:00:00Z", now))
        assertNull(Timestamps.relative("not a date", now))
    }
}
