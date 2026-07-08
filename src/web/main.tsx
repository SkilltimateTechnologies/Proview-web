import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./app.tsx";
import { StudentApp } from "./student";
import { RegisterPage } from "./register/RegisterPage.tsx";

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
		{isRegister ? (
			<RegisterPage />
		) : isStudent ? (
			<StudentApp />
		) : (
			<QueryClientProvider client={queryClient}>
				<Router>
					<App />
				</Router>
			</QueryClientProvider>
		)}
	</StrictMode>,
);
