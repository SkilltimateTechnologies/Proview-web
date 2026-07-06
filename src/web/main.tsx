import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./app.tsx";
import { StudentApp } from "./student";

const queryClient = new QueryClient();

// Student portal base path — deliberately obscure so students can't guess it.
// Any other URL falls through to the admin app (which shows the admin login).
const isStudent = window.location.pathname.startsWith("/px9k2m7");

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{isStudent ? (
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
