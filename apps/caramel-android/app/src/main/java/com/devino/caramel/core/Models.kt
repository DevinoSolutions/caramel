package com.devino.caramel.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Currency
import java.util.Locale

// Wire shapes of the existing grabcaramel.com routes (the same ones
// apps/caramel-apple/App/Core/Models.swift decodes). A server rename fails the decode loudly
// (ApiError) instead of rendering blanks.

/** lib/recentlyWorkedCoupons.ts */
@Serializable
data class RecentlyWorkedResponse(val coupons: List<RecentlyWorkedCoupon>)

@Serializable
data class RecentlyWorkedCoupon(
    val id: String,
    val code: String,
    val title: String,
    val storeDomain: String,
    val discountType: String? = null,
    val discountAmount: Double? = null,
    val lastWorkedAt: String,
) {
    val discountLabel: String? get() = DiscountFormat.label(discountType, discountAmount)
}

/** sites/top-sites and coupons/stores. `top-sites` can emit a null site. */
@Serializable
data class SitesResponse(val sites: List<String?>)

/** GET /api/coupons (CouponListRow + the coupon_signals overlay). */
@Serializable
data class CouponsPage(
    val coupons: List<Coupon>,
    val page: Int,
    val limit: Int,
    val total: Int,
    val hasMore: Boolean,
)

@Serializable
data class Coupon(
    val id: String,
    val code: String,
    val title: String,
    val description: String,
    @SerialName("discount_type") val discountType: String? = null,
    @SerialName("discount_amount") val discountAmount: Double? = null,
    val expiry: String? = null,
    val expired: Boolean,
    val verificationMessage: String? = null,
    val newCustomersOnly: Boolean? = null,
    val lastWorkedAt: String? = null,
    val keepsFailing: Boolean? = null,
) {
    val discountLabel: String? get() = DiscountFormat.label(discountType, discountAmount)
}

/** GET /api/extension/me */
@Serializable
data class MeResponse(val username: String? = null, val image: String? = null)

/** GET /api/account/favorites */
@Serializable
data class FavoritesResponse(val favorites: List<Entry>) {
    @Serializable
    data class Entry(val store: String, val createdAt: String)
}

/** PUT/DELETE /api/account/favorites/:store */
@Serializable
data class FavoriteWriteResponse(val store: String, val favorited: Boolean)

/** GET /api/account/overview (lib/profile/types.ts ProfileOverview, the slice the app shows). */
@Serializable
data class OverviewResponse(val memberSince: String? = null, val savings: Savings) {
    @Serializable
    data class SavingsTotal(val currency: String, val minorUnits: Long)

    @Serializable
    data class Savings(
        val syncEnabled: Boolean,
        val eventCount: Int,
        val storeCount: Int,
        val totals: List<SavingsTotal>,
    )
}

enum class OAuthProvider(val wireName: String) {
    APPLE("apple"),
    GOOGLE("google"),
}

/**
 * GET /api/extension/oauth/authorize. `state` is the signed state the provider hands back on
 * the redirect; the app checks the callback echoes it.
 */
@Serializable
data class OAuthAuthorizeResponse(val authorizationUrl: String, val state: String)

/** POST /api/extension/oauth (200): the minted session. */
@Serializable
data class OAuthSessionResult(val token: String, val username: String? = null, val image: String? = null)

object DiscountFormat {
    /** coupon-card.tsx's rule: PERCENTAGE renders "N%", every other type "$N". */
    fun label(type: String?, amount: Double?): String? {
        if (amount == null || amount <= 0) return null
        val number = if (amount % 1.0 == 0.0) amount.toLong().toString() else String.format(Locale.US, "%.2f", amount)
        return if (type == "PERCENTAGE") "$number% off" else "\$$number off"
    }

    fun money(minorUnits: Long, currencyCode: String, locale: Locale = Locale.getDefault()): String {
        val currency = try {
            Currency.getInstance(currencyCode)
        } catch (_: IllegalArgumentException) {
            // A code the JDK does not know: show the raw amount rather than hide the total.
            return "$minorUnits $currencyCode"
        }
        val format = NumberFormat.getCurrencyInstance(locale)
        format.currency = currency
        return format.format(minorUnits / 100.0)
    }
}

object Timestamps {
    /** The server emits JS `toISOString()` (fractional seconds); plain second resolution is also valid ISO-8601. */
    fun parse(iso: String): Instant? = try {
        Instant.parse(iso)
    } catch (_: DateTimeParseException) {
        // Not a timestamp: callers hide the line (as the iOS app does) instead of showing garbage.
        null
    }

    fun relative(iso: String, now: Instant = Instant.now()): String? {
        val then = parse(iso) ?: return null
        val seconds = Duration.between(then, now).seconds
        return when {
            seconds < 60 -> "just now"
            seconds < 3600 -> plural(seconds / 60, "minute")
            seconds < 86400 -> plural(seconds / 3600, "hour")
            seconds < 86400 * 30 -> plural(seconds / 86400, "day")
            seconds < 86400 * 365 -> plural(seconds / (86400 * 30), "month")
            else -> plural(seconds / (86400 * 365), "year")
        }
    }

    private fun plural(count: Long, unit: String): String = "$count ${if (count == 1L) unit else "${unit}s"} ago"
}
