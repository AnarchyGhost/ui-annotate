import { Component, input } from "@angular/core";

@Component({
  selector: "app-info-card",
  template: `
    <section class="card">
      <h2>{{ title() }}</h2>
      <p data-testid="card-text">Card text with some words to select</p>
    </section>
  `,
})
export class InfoCardComponent {
  readonly title = input("");
}
