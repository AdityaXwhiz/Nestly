import { usersService } from './service.js';

export const usersController = {
  async getUser(req, res, next) {
    try {
      const user = await usersService.getUserById(req.params.id);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  },
};
