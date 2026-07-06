import { Route, Switch } from "wouter";
import { AgentFeedback } from "@runablehq/website-runtime";
import { SessionProvider, useSession } from "./lib/session";
import { Shell } from "./components/shell";
import { Loader } from "./components/ui";
import Login from "./pages/login";
import Dashboard from "./pages/dashboard";
import Monitor from "./pages/monitor";
import Reports from "./pages/reports";
import ReportDetail from "./pages/report-detail";
import Exams, { NewExam, EditExam } from "./pages/exams";
import Questions from "./pages/questions";
import Users from "./pages/users";
import Sections from "./pages/sections";
import Settings from "./pages/settings";
import Branding from "./pages/branding";
import Tenants from "./pages/tenants";

function Protected() {
  const { me, loading } = useSession();
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader /></div>;
  if (!me) return <Login />;
  return (
    <Shell>
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
