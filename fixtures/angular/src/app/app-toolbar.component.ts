import { Component } from "@angular/core";

@Component({
  selector: "app-toolbar",
  template: `
    <header class="toolbar">
      <span class="toolbar__title">Fixture</span>
      <button data-testid="save" class="primary" (click)="save()">Save</button>
    </header>
  `,
})
export class AppToolbarComponent {
  save(): void {}
}
