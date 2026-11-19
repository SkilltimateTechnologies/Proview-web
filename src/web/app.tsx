import { Suspense, lazy } from "react";
import { Route, Switch } from "wouter";
import { AgentFeedback } from "@runablehq/website-runtime";
import { SessionProvider, useSession } from "./lib/session";
import { Shell } from "./components/shell";
import { Loader } from "./components/ui";
import Login from "./pages/login";
import { importWithRetry } from "./lib/lazy-chunk";

/* Each console page is its own chunk, fetched when first opened. They used to be
 * static imports, so opening the Live Monitor during an exam downloaded all 13
 * pages plus recharts (dashboard charts) and JSZip in one 724 KB file, from the
 * same single server process the students are using. Now the shell is ~70 KB and
 * a page is fetched once, then cached by the browser. importWithRetry retries a
 * failed fetch and reloads once after a deploy changed the chunk names. */
const page = <M,>(key: string, load: () => Promise<M>) => importWithRetry(load, { key: `admin-${key}` });
const Dashboard = lazy(() => page("dashboard", () => import("./pages/dashboard")));
const Monitor = lazy(() => page("monitor", () => import("./pages/monitor")));
const Reports = lazy(() => page("reports", () => import("./pages/reports")));
const ReportDetail = lazy(() => page("report-detail", () => import("./pages/report-detail")));
const Exams = lazy(() => page("exams", () => import("./pages/exams")));
const NewExam = lazy(() => page("exams", () => import("./pages/exams")).then((m) => ({ default: m.NewExam })));
const EditExam = lazy(() => page("exams", () => import("./pages/exams")).then((m) => ({ default: m.EditExam })));
const Questions = lazy(() => page("questions", () => import("./pages/questions")));
const Users = lazy(() => page("users", () => import("./pages/users")));
const Sections = lazy(() => page("sections", () => import("./pages/sections")));
const Settings = lazy(() => page("settings", () => import("./pages/settings")));
const Branding = lazy(() => page("branding", () => import("./pages/branding")));
const Tenants = lazy(() => page("tenants", () => import("./pages/tenants")));

function Protected() {
  const { me, loading } = useSession();
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader /></div>;
  if (!me) return <Login />;
  return (
    <Shell>
      <Suspense fallback={<Loader />}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/monitor" component={Monitor} />
        <Route path="/reports" component={Reports} />
        <Route path="/reports/:examId" component={ReportDetail} />
        <Route path="/exams/new" component={NewExam} />
        <Route path="/exams/:id/edit" component={EditExam} />
        <Route path="/exams" component={Exams} />
        <Route path="/questions" component={Questions} />
        <Route path="/users" component={Users} />
        <Route path="/sections" component={Sections} />
        <Route path="/settings" component={Settings} />
        <Route path="/branding" component={Branding} />
        <Route path="/tenants" component={Tenants} />
        <Route>
          <div className="card p-10 text-center text-[var(--color-ink2)]">Page not found</div>
        </Route>
      </Switch>
      </Suspense>
    </Shell>
  );
}

function App() {
  return (
    <SessionProvider>
      <Protected />
      {import.meta.env.DEV && <AgentFeedback />}
    </SessionProvider>
  );
}

export default App;
