import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { StudentApp } from "./student";
import { ErrorBoundary } from "./components/error-boundary";
import { importWithRetry, installChunkErrorRecovery } from "./lib/lazy-chunk";

/* Only one of these three roots ever renders — the URL decides, below, before
 * anything mounts. They used to be three static imports, which put all three in
 * one chunk: a student sat down to an exam and downloaded the entire admin
 * console (13 pages, recharts, the whole question bank UI) to render a login
 * box. Measured at 2.06 MB / 474 KB brotli in one file, served by the same
 * single Bun process that is answering their heartbeats, with no CDN.
 *
 * The student app stays a STATIC import on purpose. It is the exam-critical
 * path, so it must arrive in the first round trip, and it must be listed in the
 * document's own resources for the service worker's offline pre-cache (see
 * below) to see it. Admin and register become lazy chunks a student never
 * fetches; an admin pays one extra round trip at a desk, not mid-exam.
 */
const AdminApp = lazy(() => importWithRetry(() => import("./app.tsx"), { key: "admin" }));
const RegisterPage = lazy(() =>
	importWithRetry(() => import("./register/RegisterPage.tsx"), { key: "register" }).then(
		(module) => ({ default: module.RegisterPage }),
	),
);

// A chunk that never arrives is the other way to get a blank page, and the
// error boundary cannot catch it because nothing ever renders. Recover once.
installChunkErrorRecovery();

/** Shown only while a lazy admin/register chunk is in flight. Inline-styled so
 *  it cannot itself depend on a chunk that has not arrived yet. */
function BootSplash() {
	return (
		<div
			style={{
				minHeight: "100vh",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "#0f172a",
				color: "#94a3b8",
				fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
				fontSize: 14,
			}}
		>
			Loading…
		</div>
	);
}

const queryClient = new QueryClient();

// Student portal base path — deliberately obscure so students can't guess it.
// Any other URL falls through to the admin app (which shows the admin login).
const isStudent = window.location.pathname.startsWith("/px9k2m7");
// Public self-registration page: /register/<tenantId> (no login required).
const isRegister = window.location.pathname.startsWith("/register/");

// Register the offline app-shell worker so an exam survives an internet drop
// plus a page refresh (the SPA boots from cache, then resumes from localStorage).
//
// Critical detail: the hashed JS/CSS bundles that boot this page are fetched
// BEFORE the freshly-installed worker takes control, so the worker never sees
// (and never caches) them. On an offline refresh index.html would then load
// from cache but its bundles would 404 -> blank page. To close that gap we
// hand the worker the exact list of same-origin assets this page loaded and
// ask it to pre-cache them while we are still online.
if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker
			.register("/sw.js")
			.then(() => navigator.serviceWorker.ready)
			.then((reg) => {
				const worker = reg.active || navigator.serviceWorker.controller;
				if (!worker) return;
				const urls = new Set<string>();
				urls.add(window.location.origin + "/index.html");
				// Everything this document already pulled in (scripts, css, fonts, imgs).
				for (const entry of performance.getEntriesByType("resource")) {
					try {
						const u = new URL((entry as PerformanceResourceTiming).name);
						if (u.origin === window.location.origin && !u.pathname.startsWith("/api")) {
							urls.add(u.href);
						}
					} catch {
						/* ignore malformed entries */
					}
				}
				// Explicit tags too, in case a resource was served from memory cache
				// and never produced a PerformanceResourceTiming entry.
				document
					.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src], link[href]")
					.forEach((el) => {
						const raw = (el as HTMLScriptElement).src || (el as HTMLLinkElement).href;
						try {
							const u = new URL(raw, window.location.href);
							if (u.origin === window.location.origin && !u.pathname.startsWith("/api")) {
								urls.add(u.href);
							}
						} catch {
							/* ignore */
						}
					});
				worker.postMessage({ type: "CACHE_ASSETS", urls: Array.from(urls) });
			})
			.catch(() => {});
	});
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Outermost boundary: a render crash anywhere below shows a message and a
		    reload button instead of the white screen students reported during a
		    live exam. There was no boundary in the app at all before this. */}
		<ErrorBoundary>
			{isStudent ? (
				// No Suspense: the student app is a static import, so it is already
				// in the entry chunk and never suspends on a network fetch.
				<StudentApp />
			) : (
				<Suspense fallback={<BootSplash />}>
					{isRegister ? (
						<RegisterPage />
					) : (
						<QueryClientProvider client={queryClient}>
							<Router>
								<AdminApp />
							</Router>
						</QueryClientProvider>
					)}
				</Suspense>
			)}
		</ErrorBoundary>
	</StrictMode>,
);
