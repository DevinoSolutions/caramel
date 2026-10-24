import XCTest

/// AppLinkGuard is the one gate in front of the web shell (T-7842, T-7817). The
/// accept and reject lists mirror the Android twin's, so the two apps refuse the
/// same strings.
final class AppLinkGuardTests: XCTestCase {
    func testAcceptsTheOriginAndURLsUnderIt() {
        let accepted = [
            "https://grabcaramel.com",
            "https://grabcaramel.com/",
            "https://grabcaramel.com/coupons",
            "https://grabcaramel.com/coupons/stores",
            "https://grabcaramel.com/profile#favorites",
            "https://grabcaramel.com?x=1",
            "https://grabcaramel.com#a",
        ]
        for candidate in accepted {
            XCTAssertTrue(AppLinkGuard.isAllowed(candidate), "should accept \(candidate)")
        }
    }

    func testRejectsLookalikesAndOtherSchemes() {
        let rejected = [
            "http://grabcaramel.com",
            "http://grabcaramel.com/coupons",
            "https://grabcaramel.com.evil.com",
            "https://grabcaramel.com.evil.com/coupons",
            "https://grabcaramel.com@evil.com",
            "https://grabcaramel.com\\@evil.com",
            "https://grabcaramel.com:443evil",
            "https://grabcaramel.com:443",
            "https://evil.com/https://grabcaramel.com",
            "https://www.grabcaramel.com",
            "https://GRABCARAMEL.COM",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "",
        ]
        for candidate in rejected {
            XCTAssertFalse(AppLinkGuard.isAllowed(candidate), "should reject \(candidate)")
        }
    }

    func testRejectsWhitespaceControlSeparatorAndFormatCharactersAnywhere() {
        let rejected = [
            " https://grabcaramel.com",
            "https://grabcaramel.com ",
            "https://grabcaramel.com/co upons",
            "https://grabcaramel.com\t",
            "https://grabcaramel.com/\ncoupons",
            "https://grabcaramel.com/\rcoupons",
            "https://grabcaramel.com/\u{0000}",
            "https://grabcaramel.com/\u{001F}",
            "https://grabcaramel.com/\u{007F}",
            "https://grabcaramel.com/\u{0085}",
            "https://grabcaramel.com/\u{00A0}",
            "https://grabcaramel.com\u{2028}",
            "https://grabcaramel.com/\u{2029}",
            "https://grabcaramel.com/\u{200B}",
            "https://grabcaramel.com/\u{FEFF}",
            "\u{FEFF}https://grabcaramel.com",
            "https://grabcaramel.com/a\\b",
        ]
        for candidate in rejected {
            XCTAssertFalse(AppLinkGuard.isAllowed(candidate), "should reject \(candidate.debugDescription)")
        }
    }

    func testAllowedURLIsNilForARejectedString() {
        XCTAssertNil(AppLinkGuard.allowedURL("https://grabcaramel.com.evil.com"))
        XCTAssertEqual(AppLinkGuard.allowedURL("https://grabcaramel.com/coupons")?.absoluteString, "https://grabcaramel.com/coupons")
    }

    // MARK: decision(for:isMainFrame:)

    private func decision(_ string: String, mainFrame: Bool = true) -> AppLinkGuard.Decision {
        guard let url = URL(string: string) else {
            XCTFail("test URL does not parse: \(string)")
            return .cancel(reason: "unparseable")
        }
        return AppLinkGuard.decision(for: url, isMainFrame: mainFrame)
    }

    func testCaramelPagesLoadInTheShell() {
        XCTAssertEqual(decision("https://grabcaramel.com/coupons"), .loadInShell(URL(string: "https://grabcaramel.com/coupons")!))
        XCTAssertEqual(decision("https://grabcaramel.com/profile#favorites"), .loadInShell(URL(string: "https://grabcaramel.com/profile#favorites")!))
    }

    func testLoginAndSignupRunTheNativeSignIn() {
        for path in ["/login", "/login/", "//login", "///login/", "/signup", "/signup?next=%2Fprofile", "/login#x", "/%6Cogin"] {
            XCTAssertEqual(decision("https://grabcaramel.com" + path), .signIn, path)
        }
        // Only the exact pages: a lookalike path is a normal page.
        XCTAssertEqual(decision("https://grabcaramel.com/login-help"), .loadInShell(URL(string: "https://grabcaramel.com/login-help")!))
    }

    func testOtherWebsitesOpenInTheBrowser() {
        XCTAssertEqual(decision("https://example.com/page"), .openInBrowser(URL(string: "https://example.com/page")!))
        XCTAssertEqual(decision("http://example.com/page"), .openInBrowser(URL(string: "http://example.com/page")!))
        XCTAssertEqual(decision("https://www.grabcaramel.com/"), .openInBrowser(URL(string: "https://www.grabcaramel.com/")!))
    }

    func testLookalikesAreNeverLoadedInTheShell() {
        for string in ["https://grabcaramel.com.evil.com/", "http://grabcaramel.com/coupons"] {
            if case .loadInShell = decision(string) { XCTFail("\(string) must not load in the shell") }
        }
    }

    func testMailAndPhoneGoToTheSystem() {
        XCTAssertEqual(decision("mailto:support@example.com"), .openInSystem(URL(string: "mailto:support@example.com")!))
        XCTAssertEqual(decision("tel:+15555550100"), .openInSystem(URL(string: "tel:+15555550100")!))
    }

    func testEverythingElseIsCancelled() {
        let refused = ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "about:blank", "itms-apps://apps.apple.com", "com.devino.caramel://auth/callback"]
        for string in refused {
            guard case .cancel = decision(string) else {
                XCTFail("\(string) should be cancelled")
                continue
            }
        }
    }

    func testWebURLsWithCredentialsAreCancelled() {
        guard case .cancel = decision("https://user:pass@example.com/") else {
            return XCTFail("credentials in a web URL should be cancelled")
        }
    }

    func testSubframes() {
        XCTAssertEqual(decision("https://challenges.example.com/frame", mainFrame: false), .allowEmbedded)
        XCTAssertEqual(decision("about:blank", mainFrame: false), .allowEmbedded)
        guard case .cancel = decision("javascript:alert(1)", mainFrame: false) else {
            return XCTFail("a javascript: frame should be cancelled")
        }
        guard case .cancel = decision("http://example.com/", mainFrame: false) else {
            return XCTFail("an http frame should be cancelled")
        }
    }

    // MARK: Gesture gate (navigationType x target class)

    func testExternalOpensNeedATapOrAFormSubmit() {
        let targets: [(String, AppLinkGuard.Decision)] = [
            ("browser", .openInBrowser(URL(string: "https://example.com/")!)),
            ("system", .openInSystem(URL(string: "tel:+15555550100")!)),
        ]
        for (name, decision) in targets {
            XCTAssertEqual(AppLinkGuard.gate(decision, kind: .linkActivated), decision, "\(name) via a tap")
            XCTAssertEqual(AppLinkGuard.gate(decision, kind: .formSubmitted), decision, "\(name) via a form")
            XCTAssertEqual(AppLinkGuard.gate(decision, kind: .other), .blockedExternal, "\(name) via script/redirect must be blocked")
        }
    }

    func testTheGestureGateLeavesEveryOtherDecisionAlone() {
        let page = URL(string: "https://grabcaramel.com/coupons")!
        let others: [AppLinkGuard.Decision] = [.loadInShell(page), .signIn, .allowEmbedded, .blockedExternal, .cancel(reason: "x")]
        for decision in others {
            for kind in [AppLinkGuard.NavigationKind.linkActivated, .formSubmitted, .other] {
                XCTAssertEqual(AppLinkGuard.gate(decision, kind: kind), decision)
            }
        }
    }

    // MARK: Incoming links

    func testIncomingLinksLandOnlyOnAllowlistedPaths() {
        let home = URL(string: "https://grabcaramel.com/coupons")!
        let kept = [
            "https://grabcaramel.com", "https://grabcaramel.com/", "https://grabcaramel.com/coupons", "https://grabcaramel.com/coupons/humehealth.com",
            "https://grabcaramel.com/coupons/stores/a", "https://grabcaramel.com/profile", "https://grabcaramel.com/profile#favorites",
            "https://grabcaramel.com/privacy", "https://grabcaramel.com/support", "https://grabcaramel.com/support?x=1",
        ]
        for string in kept {
            XCTAssertEqual(AppLinkGuard.incomingTarget(for: URL(string: string)!, home: home), URL(string: string)!, string)
        }
        let sentHome = [
            "https://grabcaramel.com/login", "https://grabcaramel.com/signup", "https://grabcaramel.com/faq", "https://grabcaramel.com/couponsfoo",
            "https://grabcaramel.com/privacy/extra", "https://grabcaramel.com/api/account/export", "https://grabcaramel.com/welcome",
        ]
        for string in sentHome {
            XCTAssertEqual(AppLinkGuard.incomingTarget(for: URL(string: string)!, home: home), home, string)
        }
    }

    func testIncomingLinksOffTheOriginAreIgnored() {
        let home = URL(string: "https://grabcaramel.com/coupons")!
        for string in ["https://example.com/coupons", "http://grabcaramel.com/coupons", "https://grabcaramel.com.evil.com/", "javascript:alert(1)", "com.devino.caramel://auth/callback"] {
            XCTAssertNil(AppLinkGuard.incomingTarget(for: URL(string: string)!, home: home), string)
        }
    }

    // MARK: Alerts

    func testAStoreWithoutABaselineIsRecordedNotReported() {
        XCTAssertEqual(AlertsLogic.outcome(seen: nil, total: 7, visited: false), .markSeen(total: 7))
    }

    func testNewCodesAreReportedUntilTheShopperLooks() {
        XCTAssertEqual(AlertsLogic.outcome(seen: 5, total: 8, visited: false), .hit(newCodes: 3))
        XCTAssertEqual(AlertsLogic.outcome(seen: 5, total: 5, visited: false), .nothingNew)
        XCTAssertEqual(AlertsLogic.outcome(seen: 5, total: 2, visited: false), .lowerBaseline(total: 2))
    }

    func testOpeningTheStorePageCountsAsSeen() {
        XCTAssertEqual(AlertsLogic.outcome(seen: 5, total: 8, visited: true), .markSeen(total: 8))
        XCTAssertEqual(AlertsLogic.outcome(seen: 5, total: 2, visited: true), .markSeen(total: 2))
    }

    func testStorePathReadsOnlyAStorePage() {
        XCTAssertEqual(StorePath.store(fromSegments: ["coupons", "HumeHealth.com"]), "humehealth.com")
        for segments in [[], ["coupons"], ["coupons", "stores"], ["coupons", "stores", "a"], ["profile"], ["coupons", "a/b"], ["coupons", "x.com", "y"]] {
            XCTAssertNil(StorePath.store(fromSegments: segments), "\(segments)")
        }
    }

    // MARK: Shell configuration

    func testEveryShellDestinationPassesTheGuard() {
        let expected: [ShellDestination: String] = [
            .deals: "https://grabcaramel.com/coupons",
            .stores: "https://grabcaramel.com/coupons/stores",
            .saved: "https://grabcaramel.com/profile#favorites",
            .profile: "https://grabcaramel.com/profile",
        ]
        for destination in ShellDestination.allCases {
            XCTAssertEqual(destination.url.absoluteString, expected[destination], "\(destination)")
            XCTAssertTrue(AppLinkGuard.isAllowed(destination.url.absoluteString))
        }
    }

    func testStorePageAcceptsOnlyAHostname() {
        XCTAssertEqual(ShellDestination.storePage(domain: "humehealth.com")?.absoluteString, "https://grabcaramel.com/coupons/humehealth.com")
        XCTAssertNil(ShellDestination.storePage(domain: "../profile"))
        XCTAssertNil(ShellDestination.storePage(domain: "a.com/b"))
        XCTAssertNil(ShellDestination.storePage(domain: ""))
    }

    func testUserAgentContract() {
        XCTAssertEqual(ShellUserAgent.applicationName(version: "1.6.0"), "CaramelApp/1.6.0 (ios)")
    }
}
