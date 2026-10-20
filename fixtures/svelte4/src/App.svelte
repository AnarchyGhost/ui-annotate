<script>
  import AppToolbar from "./AppToolbar.svelte";
  import InfoCard from "./InfoCard.svelte";
</script>

<main class="layout">
  <AppToolbar />
  <InfoCard title="Card title" />
  <p data-testid="plain-text">Plain text in App</p>
</main>
