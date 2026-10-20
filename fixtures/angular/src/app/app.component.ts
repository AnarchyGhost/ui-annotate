import { Component } from "@angular/core";
import { AppToolbarComponent } from "./app-toolbar.component";
import { InfoCardComponent } from "./info-card.component";

@Component({
  selector: "app-root",
  imports: [AppToolbarComponent, InfoCardComponent],
  template: `
    <main class="layout">
      <app-toolbar />
      <app-info-card title="Card title" />
      <p data-testid="plain-text">Plain text in App</p>
    </main>
  `,
})
export class AppComponent {}
