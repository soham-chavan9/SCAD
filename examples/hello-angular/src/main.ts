import { Component } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, RouterLink, RouterOutlet, type Routes } from "@angular/router";

@Component({ selector: "app-home", template: "<h1>hello-angular: home</h1>" })
class Home {}

@Component({ selector: "app-about", template: "<h1>hello-angular: about (a client-side route)</h1>" })
class About {}

const routes: Routes = [
  { path: "", component: Home },
  { path: "about", component: About },
];

@Component({
  selector: "app-root",
  imports: [RouterOutlet, RouterLink],
  template: '<nav><a routerLink="/">Home</a> | <a routerLink="/about">About</a></nav><router-outlet />',
})
class App {}

bootstrapApplication(App, { providers: [provideRouter(routes)] }).catch((err: unknown) => console.error(err));
