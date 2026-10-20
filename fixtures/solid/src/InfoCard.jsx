export default function InfoCard(props) {
  return (
    <section class="card">
      <h2>{props.title}</h2>
      <p data-testid="card-text">Card text with some words to select</p>
    </section>
  );
}
