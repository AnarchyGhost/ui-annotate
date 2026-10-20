export default function AppToolbar() {
  const save = () => {};
  return (
    <header class="toolbar">
      <span class="toolbar__title">Fixture</span>
      <button data-testid="save" class="primary" onClick={save}>
        Save
      </button>
    </header>
  );
}
