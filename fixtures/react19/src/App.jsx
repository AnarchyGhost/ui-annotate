import AppToolbar from "./AppToolbar.jsx";
import InfoCard from "./InfoCard.jsx";

export default function App() {
  return (
    <main className="layout">
      <AppToolbar />
      <InfoCard title="Card title" />
      <p data-testid="plain-text">Plain text in App</p>
    </main>
  );
}
