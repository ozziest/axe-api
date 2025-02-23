import Model from "../../../src/Model";
import { IHandlerBaseMiddleware } from "../../../src/Interfaces";
import { HandlerTypes } from "../../../src/Enums";

class Login extends Model {
  get middlewares(): IHandlerBaseMiddleware[] {
    return [
      {
        handler: [HandlerTypes.PAGINATE, HandlerTypes.INSERT],
        middleware: () => {},
      },
      {
        handler: [HandlerTypes.PAGINATE, HandlerTypes.PATCH],
        middleware: () => {},
      },
    ];
  }
}

export default Login;
