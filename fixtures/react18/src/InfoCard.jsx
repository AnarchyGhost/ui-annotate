export default function InfoCard({ title }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p data-testid="card-text">Card text with some words to select</p>
    </section>
  );
}
