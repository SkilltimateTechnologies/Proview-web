import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./app.tsx";
import { StudentApp } from "./student";

const queryClient = new QueryClient();

const isStudent = window.location.pathname.startsWith("/student");

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
