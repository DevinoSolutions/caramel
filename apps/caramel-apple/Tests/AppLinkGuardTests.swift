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

// MARK: - Native-to-web session handoff (T-7852)
//
// These classes live in this file (not their own) so the generated Xcode project does not
// change: Tests/ is globbed by project.yml, so a new file would need a regenerated project.

/// The paths and URLs of the handoff contract (WebSessionHandoff in ShellConfig.swift).
final class WebSessionHandoffContractTests: XCTestCase {
    private func url(_ string: String, file: StaticString = #filePath, line: UInt = #line) -> URL {
        guard let url = URL(string: string) else {
            XCTFail("not a URL: \(string)", file: file, line: line)
            return URL(fileURLWithPath: "/")
        }
        return url
    }

    func testNextPathKeepsTheTabDestinations() {
        for destination in ShellDestination.allCases {
            XCTAssertEqual(WebSessionHandoff.nextPath(for: destination.url), destination.path, "\(destination)")
        }
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com/")), "/")
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com")), "/")
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com/coupons/amazon.com")), "/coupons/amazon.com")
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com/coupons/amazon.com?x=1#top")), "/coupons/amazon.com?x=1#top")
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com/welcome/extension")), "/welcome/extension")
    }

    func testNextPathOutsideTheServerAllowlistIsHome() {
        let outside = [
            "https://grabcaramel.com/support",
            "https://grabcaramel.com/privacy",
            "https://grabcaramel.com/login",
            "https://grabcaramel.com/api/extension/me",
            "https://grabcaramel.com/Coupons",
            "https://grabcaramel.com/couponsfoo",
            "https://grabcaramel.com/?x=1",
            "https://grabcaramel.com/#frag",
            "https://evil.com/coupons",
            "https://grabcaramel.com.evil.com/coupons",
        ]
        for candidate in outside {
            XCTAssertEqual(WebSessionHandoff.nextPath(for: url(candidate)), "/", candidate)
        }
        // "/?x=1" is on the home page but the server only takes a bare "/", so it is still sent as "/".
        XCTAssertEqual(WebSessionHandoff.exactNextPath(for: url("https://grabcaramel.com/?x=1")), "/")
        for candidate in ["https://grabcaramel.com/support", "https://grabcaramel.com/login", "https://evil.com/coupons"] {
            XCTAssertNil(WebSessionHandoff.exactNextPath(for: url(candidate)), candidate)
        }
    }

    func testNextPathNormalizesDoubleSlashesAndRefusesWhatTheServerRefuses() {
        // The server rejects a "//" prefix; the segments are rejoined.
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com//coupons")), "/coupons")
        // Percent-encoded CR/LF (header injection) and anything over 512 characters.
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com/coupons/a%0Ab")), "/")
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com/coupons/a%0db")), "/")
        let long = "https://grabcaramel.com/coupons/" + String(repeating: "a", count: 520)
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url(long)), "/")
        XCTAssertNil(WebSessionHandoff.exactNextPath(for: url(long)))
        let justFits = "/coupons/" + String(repeating: "a", count: 512 - "/coupons/".count)
        XCTAssertEqual(WebSessionHandoff.nextPath(for: url("https://grabcaramel.com" + justFits)), justFits)
    }

    func testSessionPagesAreTheServersAllowlist() {
        let sessionPages = [
            "https://grabcaramel.com", "https://grabcaramel.com/", "https://grabcaramel.com/?x=1",
            "https://grabcaramel.com/coupons", "https://grabcaramel.com/coupons/stores/a",
            "https://grabcaramel.com/profile", "https://grabcaramel.com/profile#favorites",
            "https://grabcaramel.com/welcome/extension",
        ]
        for candidate in sessionPages {
            XCTAssertTrue(WebSessionHandoff.isSessionPage(url(candidate)), candidate)
        }
        let others = [
            "https://grabcaramel.com/login", "https://grabcaramel.com/login?error=handoff_expired",
            "https://grabcaramel.com/support", "https://grabcaramel.com/api/app/web-session/redeem?code=x",
            "https://evil.com/coupons", "http://grabcaramel.com/coupons",
        ]
        for candidate in others {
            XCTAssertFalse(WebSessionHandoff.isSessionPage(url(candidate)), candidate)
        }
    }

    func testVettedRedeemURLAcceptsOnlyTheRedeemRouteWithACode() {
        let code = String(repeating: "a", count: 43)
        let good = "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)"
        XCTAssertEqual(WebSessionHandoff.vettedRedeemURL(good), url(good))

        let bad = [
            "https://evil.com/api/app/web-session/redeem?code=\(code)",
            "https://grabcaramel.com.evil.com/api/app/web-session/redeem?code=\(code)",
            "https://grabcaramel.com@evil.com/api/app/web-session/redeem?code=\(code)",
            "http://grabcaramel.com/api/app/web-session/redeem?code=\(code)",
            "https://www.grabcaramel.com/api/app/web-session/redeem?code=\(code)",
            "https://grabcaramel.com/api/app/web-session/handoff?code=\(code)",
            "https://grabcaramel.com/api/app/web-session/redeem/extra?code=\(code)",
            "https://grabcaramel.com/coupons?code=\(code)",
            "https://grabcaramel.com/api/app/web-session/redeem",
            "https://grabcaramel.com/api/app/web-session/redeem?code=",
            "https://grabcaramel.com/api/app/web-session/redeem?other=\(code)",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)#frag",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code.dropLast())",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)a",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code.dropLast())%2B",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code.dropLast())+",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)&code=\(code)",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)&next=/profile",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code) ",
            "https://grabcaramel.com\\api/app/web-session/redeem?code=\(code)",
            "javascript:alert(1)",
            "",
        ]
        for candidate in bad {
            XCTAssertNil(WebSessionHandoff.vettedRedeemURL(candidate), candidate)
        }
    }

    func testExpiredRedirectIsTheLoginPageWithTheHandoffError() {
        XCTAssertTrue(WebSessionHandoff.isExpiredRedirect(url("https://grabcaramel.com/login?error=handoff_expired")))
        XCTAssertTrue(WebSessionHandoff.isExpiredRedirect(url("https://grabcaramel.com/login/?x=1&error=handoff_expired")))
        XCTAssertFalse(WebSessionHandoff.isExpiredRedirect(url("https://grabcaramel.com/login")))
        XCTAssertFalse(WebSessionHandoff.isExpiredRedirect(url("https://grabcaramel.com/login?error=other")))
        XCTAssertFalse(WebSessionHandoff.isExpiredRedirect(url("https://grabcaramel.com/signup?error=handoff_expired")))
        XCTAssertFalse(WebSessionHandoff.isExpiredRedirect(url("https://grabcaramel.com/profile?error=handoff_expired")))
        XCTAssertFalse(WebSessionHandoff.isExpiredRedirect(url("https://evil.com/login?error=handoff_expired")))
    }

    func testIssuedCodesAre43Base64URLCharacters() {
        XCTAssertTrue(WebSessionHandoff.isIssuedCode(String(repeating: "A", count: 43)))
        XCTAssertTrue(WebSessionHandoff.isIssuedCode(String(repeating: "-", count: 21) + String(repeating: "_", count: 22)))
        XCTAssertFalse(WebSessionHandoff.isIssuedCode(String(repeating: "A", count: 42)))
        XCTAssertFalse(WebSessionHandoff.isIssuedCode(String(repeating: "A", count: 44)))
        XCTAssertFalse(WebSessionHandoff.isIssuedCode(String(repeating: "A", count: 42) + "="))
        XCTAssertFalse(WebSessionHandoff.isIssuedCode(String(repeating: "A", count: 42) + "+"))
        XCTAssertFalse(WebSessionHandoff.isIssuedCode(String(repeating: "A", count: 42) + "/"))
        XCTAssertFalse(WebSessionHandoff.isIssuedCode(""))
    }

    func testSessionCookieDetection() throws {
        func cookie(_ name: String, domain: String) throws -> HTTPCookie {
            try XCTUnwrap(HTTPCookie(properties: [.name: name, .value: "v", .domain: domain, .path: "/"]))
        }
        XCTAssertTrue(WebSessionHandoff.hasSessionCookie([try cookie("__Secure-better-auth.session_token", domain: "grabcaramel.com")]))
        XCTAssertTrue(WebSessionHandoff.hasSessionCookie([try cookie("better-auth.session_token", domain: ".grabcaramel.com")]))
        XCTAssertFalse(WebSessionHandoff.hasSessionCookie([]))
        XCTAssertFalse(WebSessionHandoff.hasSessionCookie([try cookie("other", domain: "grabcaramel.com")]))
        XCTAssertFalse(WebSessionHandoff.hasSessionCookie([try cookie("__Secure-better-auth.session_token", domain: "evil.com")]))
    }

    func testRedeemURLsAreRecognisedAndNeverTheRetryTarget() {
        XCTAssertTrue(WebSessionHandoff.isRedeemURL(url("https://grabcaramel.com/api/app/web-session/redeem?code=abc")))
        XCTAssertFalse(WebSessionHandoff.isRedeemURL(url("https://grabcaramel.com/coupons")))
        XCTAssertFalse(WebSessionHandoff.isRedeemURL(url("https://evil.com/api/app/web-session/redeem?code=abc")))
    }
}

/// Intercepts the handoff client's URLSession so the tests need no network.
final class HandoffStubURLProtocol: URLProtocol {
    /// Set by each test; nil fails the request loudly.
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    /// A request's body: URLSession hands URLProtocol a stream, not `httpBody`.
    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// WebSessionHandoffClient against a stubbed server: the request it sends and what each answer means.
final class WebSessionHandoffClientTests: XCTestCase {
    private let bearer = "bearer-secret-value-123"
    private let code = String(repeating: "c", count: 43)
    private var redeemURLString: String { "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)" }

    override func tearDown() {
        HandoffStubURLProtocol.handler = nil
        super.tearDown()
    }

    private func makeClient() -> WebSessionHandoffClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HandoffStubURLProtocol.self]
        return WebSessionHandoffClient(session: URLSession(configuration: configuration), timeout: 5)
    }

    private func respond(status: Int, body: String, for request: URLRequest) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        return (response, Data(body.utf8))
    }

    private func failure(of call: () async throws -> URL, file: StaticString = #filePath, line: UInt = #line) async -> WebSessionHandoffError? {
        do {
            let url = try await call()
            XCTFail("expected a failure, got \(url.path)", file: file, line: line)
            return nil
        } catch let error as WebSessionHandoffError {
            return error
        } catch {
            XCTFail("expected a WebSessionHandoffError, got \(error)", file: file, line: line)
            return nil
        }
    }

    func testSuccessSendsABearerOnlyJSONPostAndReturnsTheVettedURL() async throws {
        var seen: URLRequest?
        var seenBody = Data()
        HandoffStubURLProtocol.handler = { [self] request in
            seen = request
            seenBody = HandoffStubURLProtocol.body(of: request)
            return respond(status: 200, body: #"{"url":"\#(redeemURLString)","expiresInSeconds":60}"#, for: request)
        }
        let url = try await makeClient().redeemURL(next: "/profile#favorites", bearer: bearer)
        XCTAssertEqual(url.absoluteString, redeemURLString)
        let request = try XCTUnwrap(seen)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://grabcaramel.com/api/app/web-session/handoff")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(bearer)")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNotNil(request.value(forHTTPHeaderField: "x-request-id"))
        XCTAssertFalse(request.httpShouldHandleCookies, "the route is bearer-only; no cookie may ride along")
        XCTAssertEqual(request.timeoutInterval, 5)
        let body = try JSONSerialization.jsonObject(with: seenBody) as? [String: String]
        XCTAssertEqual(body, ["next": "/profile#favorites"])
    }

    func testA401MeansTheNativeSessionIsDead() async {
        HandoffStubURLProtocol.handler = { [self] request in respond(status: 401, body: #"{"error":"unauthorized"}"#, for: request) }
        let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
        XCTAssertEqual(error, .unauthorized)
    }

    func testServerErrorsAndRateLimitsAreRetryable() async {
        for status in [429, 500, 502, 503] {
            HandoffStubURLProtocol.handler = { [self] request in respond(status: status, body: "{}", for: request) }
            let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
            guard case .unavailable(let detail)? = error else {
                XCTFail("HTTP \(status) should be unavailable, got \(String(describing: error))")
                continue
            }
            XCTAssertTrue(detail.contains("HTTP \(status)"), detail)
        }
    }

    func testATimeoutAndANetworkErrorAreRetryable() async {
        for code in [URLError.timedOut, URLError.notConnectedToInternet, URLError.networkConnectionLost] {
            HandoffStubURLProtocol.handler = { _ in throw URLError(code) }
            let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
            guard case .unavailable? = error else {
                XCTFail("URLError \(code.rawValue) should be unavailable, got \(String(describing: error))")
                continue
            }
        }
    }

    func testOtherClientErrorsAreAFinalRefusal() async {
        HandoffStubURLProtocol.handler = { [self] request in respond(status: 400, body: #"{"error":"invalid next"}"#, for: request) }
        let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
        guard case .rejected(let status, _)? = error else {
            return XCTFail("a 400 should be rejected, got \(String(describing: error))")
        }
        XCTAssertEqual(status, 400)
    }

    func testARedeemURLThatFailsAppLinkGuardIsNeverReturned() async {
        let hostile = [
            "https://evil.com/api/app/web-session/redeem?code=\(code)",
            "https://grabcaramel.com.evil.com/api/app/web-session/redeem?code=\(code)",
            "http://grabcaramel.com/api/app/web-session/redeem?code=\(code)",
            "https://grabcaramel.com@evil.com/api/app/web-session/redeem?code=\(code)",
            "javascript:alert(1)",
        ]
        for candidate in hostile {
            HandoffStubURLProtocol.handler = { request in
                self.respond(status: 200, body: #"{"url":"\#(candidate)","expiresInSeconds":60}"#, for: request)
            }
            let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
            guard case .untrustedRedeemURL? = error else {
                XCTFail("\(candidate) should be untrusted, got \(String(describing: error))")
                continue
            }
        }
    }

    func testARedeemURLOnTheWrongPathIsNeverReturned() async {
        let wrongPaths = [
            "https://grabcaramel.com/coupons?code=\(code)",
            "https://grabcaramel.com/api/app/web-session/handoff?code=\(code)",
            "https://grabcaramel.com/api/app/web-session/redeem",
            "https://grabcaramel.com/api/app/web-session/redeem?code=\(code)#frag",
        ]
        for candidate in wrongPaths {
            HandoffStubURLProtocol.handler = { request in
                self.respond(status: 200, body: #"{"url":"\#(candidate)","expiresInSeconds":60}"#, for: request)
            }
            let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
            guard case .untrustedRedeemURL? = error else {
                XCTFail("\(candidate) should be untrusted, got \(String(describing: error))")
                continue
            }
        }
    }

    func testABodyWithoutAURLIsMalformed() async {
        for body in ["{}", "not json", #"{"url":42}"#, ""] {
            HandoffStubURLProtocol.handler = { request in self.respond(status: 200, body: body, for: request) }
            let error = await failure { try await makeClient().redeemURL(next: "/", bearer: bearer) }
            guard case .malformedResponse? = error else {
                XCTFail("body \(body) should be malformed, got \(String(describing: error))")
                continue
            }
        }
    }

    func testFailureTextNeverCarriesTheBearerTheCodeOrTheRedeemURL() async {
        var errors: [WebSessionHandoffError] = []
        let cases: [(Int, String)] = [
            (401, "{}"), (503, "{}"), (400, "{}"), (200, "nope"),
            (200, #"{"url":"https://evil.com/api/app/web-session/redeem?code=\#(code)"}"#),
        ]
        for (status, body) in cases {
            HandoffStubURLProtocol.handler = { request in self.respond(status: status, body: body, for: request) }
            if let error = await failure(of: { try await makeClient().redeemURL(next: "/", bearer: bearer) }) {
                errors.append(error)
            }
        }
        HandoffStubURLProtocol.handler = { _ in throw URLError(.timedOut) }
        if let error = await failure(of: { try await makeClient().redeemURL(next: "/", bearer: bearer) }) {
            errors.append(error)
        }
        XCTAssertEqual(errors.count, 6)
        for error in errors {
            let text = error.errorDescription ?? ""
            XCTAssertFalse(text.contains(bearer), text)
            XCTAssertFalse(text.contains(code), text)
            XCTAssertFalse(text.contains("redeem"), text)
        }
    }

    func testACancelledTaskIsACancellationNotAFailure() async {
        HandoffStubURLProtocol.handler = { _ in throw URLError(.cancelled) }
        do {
            _ = try await makeClient().redeemURL(next: "/", bearer: bearer)
            XCTFail("expected a cancellation")
        } catch is CancellationError {
            // expected
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
    }
}

/// WebSessionMachine: when the web session is active, and the no-loop rules around failures.
final class WebSessionMachineTests: XCTestCase {
    func testAHandoffMakesTheSessionActiveOnlyAfterTheRedeemLands() {
        var machine = WebSessionMachine()
        XCTAssertEqual(machine.phase, .inactive)
        XCTAssertFalse(machine.isActive)
        XCTAssertTrue(machine.begin())
        XCTAssertEqual(machine.phase, .handingOff(freshHandoffUsed: false))
        XCTAssertFalse(machine.isActive, "requesting the handoff is not a web session yet")
        XCTAssertTrue(machine.redeemLanded())
        XCTAssertTrue(machine.isActive)
    }

    func testOnlyOneHandoffAtATimeAndNoneWhileActive() {
        var machine = WebSessionMachine()
        XCTAssertTrue(machine.begin())
        XCTAssertFalse(machine.begin(), "a second tab must wait for the one in flight")
        XCTAssertTrue(machine.redeemLanded())
        XCTAssertFalse(machine.begin(), "an active web session needs no handoff")
    }

    func testResetDropsEveryStateBackToInactive() {
        for setup in 0..<4 {
            var machine = WebSessionMachine()
            switch setup {
            case 0: break
            case 1: _ = machine.begin()
            case 2: _ = machine.begin(); _ = machine.redeemLanded()
            default: _ = machine.begin(); _ = machine.handoffRequestFailed(.unavailable(detail: "x"))
            }
            machine.reset()
            XCTAssertEqual(machine.phase, .inactive, "setup \(setup)")
        }
    }

    func testSignOutOrDeletionAfterActiveEndsTheWebSession() {
        var machine = WebSessionMachine()
        _ = machine.begin()
        _ = machine.redeemLanded()
        machine.reset()
        XCTAssertFalse(machine.isActive)
        XCTAssertTrue(machine.begin(), "the next sign-in hands off again")
    }

    func testGenerationChangesOnStartRetryAndReset() {
        var machine = WebSessionMachine()
        var seen: Set<Int> = [machine.generation]
        _ = machine.begin()
        seen.insert(machine.generation)
        _ = machine.redeemExpired()
        seen.insert(machine.generation)
        machine.reset()
        seen.insert(machine.generation)
        XCTAssertEqual(seen.count, 4, "a late result of an abandoned handoff must be recognisable")
    }

    func testA401FromTheHandoffEndsTheNativeSessionWithoutRetrying() {
        var machine = WebSessionMachine()
        _ = machine.begin()
        XCTAssertEqual(machine.handoffRequestFailed(.unauthorized), .endNativeSession)
        XCTAssertEqual(machine.phase, .inactive)
        XCTAssertFalse(machine.isActive)
    }

    func testNetworkAndServerErrorsShowAnErrorAndAllowARetry() {
        let errors: [WebSessionHandoffError] = [
            .unavailable(detail: "HTTP 503"),
            .rejected(status: 400, requestID: "r"),
            .malformedResponse(requestID: "r"),
            .untrustedRedeemURL(requestID: "r"),
        ]
        for error in errors {
            var machine = WebSessionMachine()
            _ = machine.begin()
            guard case .showError(let message) = machine.handoffRequestFailed(error) else {
                XCTFail("\(error) should show an error")
                continue
            }
            XCTAssertFalse(message.isEmpty)
            XCTAssertEqual(machine.phase, .failed(message))
            XCTAssertFalse(machine.isActive)
            XCTAssertTrue(machine.begin(), "the shopper's retry starts a new handoff (\(error))")
        }
    }

    func testAnExpiredRedeemGetsExactlyOneFreshHandoffThenNativeSignIn() {
        var machine = WebSessionMachine()
        _ = machine.begin()
        XCTAssertEqual(machine.redeemExpired(), .requestHandoff)
        XCTAssertEqual(machine.phase, .handingOff(freshHandoffUsed: true))
        XCTAssertEqual(machine.redeemExpired(), .showNativeSignIn, "no third attempt")
        XCTAssertEqual(machine.phase, .inactive)
        XCTAssertFalse(machine.isActive)
        XCTAssertEqual(machine.redeemExpired(), .none, "nothing in flight: nothing to retry")
    }

    func testTheFreshHandoffCanStillLand() {
        var machine = WebSessionMachine()
        _ = machine.begin()
        XCTAssertEqual(machine.redeemExpired(), .requestHandoff)
        XCTAssertTrue(machine.redeemLanded())
        XCTAssertTrue(machine.isActive)
    }

    func testAFreshShopperAttemptGetsItsOwnRetryBudget() {
        var machine = WebSessionMachine()
        _ = machine.begin()
        _ = machine.redeemExpired()
        _ = machine.redeemExpired()
        XCTAssertTrue(machine.begin())
        XCTAssertEqual(machine.redeemExpired(), .requestHandoff)
    }

    func testAFailedRedeemNavigationShowsAnErrorAndAllowsARetry() {
        var machine = WebSessionMachine()
        _ = machine.begin()
        XCTAssertEqual(machine.redeemNavigationFailed("offline"), .showError("offline"))
        XCTAssertEqual(machine.phase, .failed("offline"))
        XCTAssertTrue(machine.begin())
    }

    func testEventsThatArriveWithNoHandoffInFlightAreIgnored() {
        var machine = WebSessionMachine()
        XCTAssertFalse(machine.redeemLanded())
        XCTAssertEqual(machine.handoffRequestFailed(.unauthorized), .none)
        XCTAssertEqual(machine.redeemNavigationFailed("x"), .none)
        XCTAssertEqual(machine.phase, .inactive)

        _ = machine.begin()
        _ = machine.redeemLanded()
        XCTAssertEqual(machine.handoffRequestFailed(.unauthorized), .none, "a late 401 must not end an active session")
        XCTAssertEqual(machine.redeemExpired(), .none)
        XCTAssertTrue(machine.isActive)
    }
}
